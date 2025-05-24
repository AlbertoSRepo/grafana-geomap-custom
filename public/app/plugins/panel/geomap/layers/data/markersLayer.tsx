import { isNumber } from 'lodash';
import { FeatureLike } from 'ol/Feature';
import Map from 'ol/Map';
import VectorImage from 'ol/layer/VectorImage';
import { ReactNode } from 'react';
import { ReplaySubject } from 'rxjs';

import {
  MapLayerRegistryItem,
  MapLayerOptions,
  PanelData,
  GrafanaTheme2,
  FrameGeometrySourceMode,
  EventBus,
  Field,
  FieldType,
} from '@grafana/data';
import { FrameVectorSource } from 'app/features/geo/utils/frameVectorSource';
import { getLocationMatchers } from 'app/features/geo/utils/location';

import { MarkersLegend, MarkersLegendProps } from '../../components/MarkersLegend';
import { ObservablePropsWrapper } from '../../components/ObservablePropsWrapper';
import { StyleEditor } from '../../editor/StyleEditor';
import { defaultStyleConfig, StyleConfig } from '../../style/types';
import { getStyleConfigState } from '../../style/utils';
import { getStyleDimension } from '../../utils/utils';

// Configuration options for Circle overlays
export interface MarkersConfig {
  style: StyleConfig;
  showLegend?: boolean;
  showCustomControl?: boolean;
  searchField?: string;
}

const defaultOptions: MarkersConfig = {
  style: defaultStyleConfig,
  showLegend: true,
  showCustomControl: false,
  searchField: undefined,  // Cambia da 'name' a undefined
};

export const MARKERS_LAYER_ID = 'markers';

// Used by default when nothing is configured
export const defaultMarkersConfig: MapLayerOptions<MarkersConfig> = {
  type: MARKERS_LAYER_ID,
  name: '', // will get replaced
  config: defaultOptions,
  location: {
    mode: FrameGeometrySourceMode.Auto,
  },
  tooltip: true,
};

/**
 * Map layer configuration for circle overlay
 */
export const markersLayer: MapLayerRegistryItem<MarkersConfig> = {
  id: MARKERS_LAYER_ID,
  name: 'Markers',
  description: 'Use markers to render each data point',
  isBaseMap: false,
  showLocation: true,
  hideOpacity: true,

  /**
   * Function that configures transformation and returns a transformer
   * @param map
   * @param options
   * @param theme
   */
  create: async (map: Map, options: MapLayerOptions<MarkersConfig>, eventBus: EventBus, theme: GrafanaTheme2) => {
    // Assert default values
    const config = {
      ...defaultOptions,
      ...options?.config,
    };

    const style = await getStyleConfigState(config.style);
    const location = await getLocationMatchers(options.location);
    const source = new FrameVectorSource(location);
    const vectorLayer = new VectorImage({
      source,
      declutter: false
    });

    const legendProps = new ReplaySubject<MarkersLegendProps>(1);
    let legend: ReactNode = null;
    if (config.showLegend) {
      legend = <ObservablePropsWrapper watch={legendProps} initialSubProps={{}} child={MarkersLegend} />;
    }

    if (!style.fields) {
      vectorLayer.setStyle(style.maker(style.base));
    } else {
      vectorLayer.setStyle((feature: FeatureLike) => {
        const idx = feature.get('rowIndex');
        const dims = style.dims;
        if (!dims || !isNumber(idx)) {
          return style.maker(style.base);
        }

        const values = { ...style.base };

        if (dims.color) {
          values.color = dims.color.get(idx);
        }
        if (dims.size) {
          values.size = dims.size.get(idx);
        }
        if (dims.text) {
          values.text = dims.text.get(idx);
        }
        if (dims.rotation) {
          values.rotation = dims.rotation.get(idx);
        }
        return style.maker(values);
      });
    }

    return {
      init: () => vectorLayer,
      legend: legend,
      update: (data: PanelData) => {
        if (!data.series?.length) {
          return;
        }

        for (const frame of data.series) {
          style.dims = getStyleDimension(frame, style, theme);

          if (legend) {
            legendProps.next({
              styleConfig: style,
              size: style.dims?.size,
              layerName: options.name,
              layer: vectorLayer,
            });
          }

          source.update(frame);
          
          break; // Solo il primo frame per ora
        }
      },

      dispose: () => {
        // Rimosso il codice relativo a customControl
      },

      // Marker overlay options
      registerOptionsUI: (builder) => {
        builder
          .addCustomEditor({
            id: 'config.style',
            path: 'config.style',
            name: 'Styles',
            editor: StyleEditor,
            settings: {
              displayRotation: true,
            },
            defaultValue: defaultOptions.style,
          })
          .addBooleanSwitch({
            path: 'config.showLegend',
            name: 'Show legend',
            description: 'Show map legend',
            defaultValue: defaultOptions.showLegend,
          })
          .addBooleanSwitch({
            path: 'config.showCustomControl',
            name: 'Show search control',
            description: 'Show search button in the map',
            defaultValue: defaultOptions.showCustomControl,
          })
          .addCustomEditor({
            id: 'config.searchFieldWarning',
            path: 'config.searchFieldWarning',
            name: '',
            editor: function SearchFieldRequiredWarning({ context }) {
              const { showCustomControl, searchField } = context.options?.config || {};
              if (showCustomControl && !searchField) {
                return <div style={{ color: 'orange' }}>Please select a search field below</div>;
              }
              return null;
            },
            showIf: (config) => !!(config as MapLayerOptions<MarkersConfig>).config?.showCustomControl,
          })
          .addFieldNamePicker({
            path: 'config.searchField',
            name: 'Search field',
            description: 'Select the field to search in',
            settings: {
              filter: (f: Field) => f.type === FieldType.string, // Solo campi stringa
              noFieldsMessage: 'No string fields found',
              placeholderText: 'Select field for search',
              required: true, // Aggiungi questa riga per renderlo obbligatorio
            },
            defaultValue: defaultOptions.searchField,
            showIf: (config) => !!(config as MapLayerOptions<MarkersConfig>).config?.showCustomControl, // Mostra solo se showCustomControl è true
          });
      },
    };
  },

  // fill in the default values
  defaultOptions,
};
