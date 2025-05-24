import { css } from '@emotion/css';
import { Global } from '@emotion/react';
import { Map as OpenLayersMap, MapBrowserEvent, View } from 'ol';
import Attribution from 'ol/control/Attribution';
import ScaleLine from 'ol/control/ScaleLine';
import Zoom from 'ol/control/Zoom';
import { Coordinate } from 'ol/coordinate';
import { isEmpty } from 'ol/extent';
import Feature, { FeatureLike } from 'ol/Feature';
import VectorLayer from 'ol/layer/Vector';
import MouseWheelZoom from 'ol/interaction/MouseWheelZoom';
import { fromLonLat } from 'ol/proj';
import { Component, ReactNode } from 'react';
import * as React from 'react';
import { Subscription } from 'rxjs';
import { getUid } from 'ol';
import { Style } from 'ol/style';

import { DataHoverEvent, PanelData, PanelProps } from '@grafana/data';
import { config } from '@grafana/runtime';
import { PanelContext, PanelContextRoot } from '@grafana/ui';
import { PanelEditExitedEvent } from 'app/types/events';

import { GeomapOverlay, OverlayProps } from './GeomapOverlay';
import { GeomapTooltip } from './GeomapTooltip';
import { DebugOverlay } from './components/DebugOverlay';
import { MeasureOverlay } from './components/MeasureOverlay';
import { MeasureVectorLayer } from './components/MeasureVectorLayer';
import { GeomapHoverPayload } from './event';
import { getGlobalStyles } from './globalStyles';
import { defaultMarkersConfig, MARKERS_LAYER_ID, MarkersConfig } from './layers/data/markersLayer';
import { DEFAULT_BASEMAP_CONFIG } from './layers/registry';
import { ControlsOptions, Options, MapLayerState, MapViewConfig, TooltipMode } from './types';
import { getActions } from './utils/actions';
import { getLayersExtent } from './utils/getLayersExtent';
import { applyLayerFilter, initLayer } from './utils/layers';
import { pointerClickListener, pointerMoveListener, setTooltipListeners } from './utils/tooltip';
import { updateMap, getNewOpenLayersMap, notifyPanelEditor } from './utils/utils';
import { centerPointRegistry, MapCenterID } from './view';

import { CustomControl } from './controls/CustomControl';

// Allows multiple panels to share the same view instance
let sharedView: View | undefined = undefined;

type Props = PanelProps<Options>;
interface State extends OverlayProps {
  ttip?: GeomapHoverPayload;
  ttipOpen: boolean;
  legends: ReactNode[];
  measureMenuActive?: boolean;
}

export class GeomapPanel extends Component<Props, State> {
  declare context: React.ContextType<typeof PanelContextRoot>;
  static contextType = PanelContextRoot;
  panelContext: PanelContext | undefined = undefined;
  private subs = new Subscription();

  globalCSS = getGlobalStyles(config.theme2);

  mouseWheelZoom?: MouseWheelZoom;
  hoverPayload: GeomapHoverPayload = { point: {}, pageX: -1, pageY: -1 };
  readonly hoverEvent = new DataHoverEvent(this.hoverPayload);

  map?: OpenLayersMap;
  mapDiv?: HTMLDivElement;
  layers: MapLayerState[] = [];
  readonly byName = new Map<string, MapLayerState>();

  constructor(props: Props) {
    super(props);
    this.state = { ttipOpen: false, legends: [] };
    this.subs.add(
      this.props.eventBus.subscribe(PanelEditExitedEvent, (evt) => {
        if (this.mapDiv && this.props.id === evt.payload) {
          this.initMapRef(this.mapDiv);
        }
      })
    );
  }

  componentDidMount() {
    this.panelContext = this.context;
  }

  componentWillUnmount() {
    this.subs.unsubscribe();
    for (const lyr of this.layers) {
      lyr.handler.dispose?.();
    }
    // Ensure map is disposed
    this.map?.dispose();
  }

  shouldComponentUpdate(nextProps: Props) {
    if (!this.map) {
      return true; // not yet initialized
    }

    // Check for resize
    if (this.props.height !== nextProps.height || this.props.width !== nextProps.width) {
      this.map.updateSize();
    }

    // External data changed
    if (this.props.data !== nextProps.data) {
      this.dataChanged(nextProps.data);
    }

    // Options changed
    if (this.props.options !== nextProps.options) {
      this.optionsChanged(nextProps.options);
    }

    return true; // always?
  }

  componentDidUpdate(prevProps: Props) {
    if (this.map && (this.props.height !== prevProps.height || this.props.width !== prevProps.width)) {
      this.map.updateSize();
    }
    // Check for a difference between previous data and component data
    if (this.map && this.props.data !== prevProps.data) {
      this.dataChanged(this.props.data);
    }
  }

  /** This function will actually update the JSON model */
  doOptionsUpdate(selected: number) {
    const { options, onOptionsChange } = this.props;
    const layers = this.layers;
    this.map?.getLayers().forEach((l) => {
      if (l instanceof MeasureVectorLayer) {
        this.map?.removeLayer(l);
        this.map?.addLayer(l);
      }
    });
    
    const newOptions = {
      ...options,
      basemap: layers[0].options,
      layers: layers.slice(1).map((v) => v.options),
    };
    
    onOptionsChange(newOptions);

    // Reinizializza i controlli dopo l'aggiornamento delle opzioni
    this.initControls(options.controls ?? { showZoom: true, showAttribution: true });

    notifyPanelEditor(this, layers, selected);
    this.setState({ legends: this.getLegends() });
  }

  actions = getActions(this);

  /**
   * Called when the panel options change
   *
   * NOTE: changes to basemap and layers are handled independently
   */
  optionsChanged(options: Options) {
    const oldOptions = this.props.options;
    if (options.view !== oldOptions.view) {
      const view = this.initMapView(options.view);

      if (this.map && view) {
        this.map.setView(view);
      }
    }

    if (options.controls !== oldOptions.controls) {
      this.initControls(options.controls ?? { showZoom: true, showAttribution: true });
    }

    // Aggiungi questo controllo per gestire i cambiamenti nei layer
    if (options.layers !== oldOptions.layers || options.basemap !== oldOptions.basemap) {
      // Reinizializza i controlli quando i layer cambiano
      this.initControls(options.controls ?? { showZoom: true, showAttribution: true });
    }
  }

  /**
   * Called when PanelData changes (query results etc)
   */
  dataChanged(data: PanelData) {
    // Only update if panel data matches component data
    if (data === this.props.data) {
      for (const state of this.layers) {
        applyLayerFilter(state.handler, state.options, this.props.data);
      }
    }

    // Because data changed, check map view and change if needed (data fit)
    const v = centerPointRegistry.getIfExists(this.props.options.view.id);
    if (v && v.id === MapCenterID.Fit) {
      const view = this.initMapView(this.props.options.view);

      if (this.map && view) {
        this.map.setView(view);
      }
    }
  }

  initMapRef = async (div: HTMLDivElement) => {
    if (!div) {
      // Do not initialize new map or dispose old map
      return;
    }
    this.mapDiv = div;
    if (this.map) {
      this.map.dispose();
    }

    const { options } = this.props;

    const map = getNewOpenLayersMap(this, options, div);

    this.byName.clear();
    const layers: MapLayerState[] = [];
    try {
      layers.push(await initLayer(this, map, options.basemap ?? DEFAULT_BASEMAP_CONFIG, true));

      // Default layer values
      if (!options.layers) {
        options.layers = [defaultMarkersConfig];
      }

      for (const lyr of options.layers) {
        layers.push(await initLayer(this, map, lyr, false));
      }
    } catch (ex) {
      console.error('error loading layers', ex);
    }

    for (const lyr of layers) {
      map.addLayer(lyr.layer);
    }
    this.layers = layers;
    this.map = map; // redundant
    this.initViewExtent(map.getView(), options.view);

    this.mouseWheelZoom = new MouseWheelZoom();
    this.map?.addInteraction(this.mouseWheelZoom);

    updateMap(this, options);
    setTooltipListeners(this);
    notifyPanelEditor(this, layers, layers.length - 1);

    this.setState({ legends: this.getLegends() });
  };

  clearTooltip = () => {
    if (this.state.ttip && !this.state.ttipOpen) {
      this.tooltipPopupClosed();
    }
  };

  tooltipPopupClosed = () => {
    this.setState({ ttipOpen: false, ttip: undefined });
  };

  pointerClickListener = (evt: MapBrowserEvent<MouseEvent>) => {
    pointerClickListener(evt, this);
  };

  pointerMoveListener = (evt: MapBrowserEvent<MouseEvent>) => {
    pointerMoveListener(evt, this);
  };

  initMapView = (config: MapViewConfig): View | undefined => {
    let view = new View({
      center: [0, 0],
      zoom: 1,
      showFullExtent: true, // allows zooming so the full range is visible
    });

    // With shared views, all panels use the same view instance
    if (config.shared) {
      if (!sharedView) {
        sharedView = view;
      } else {
        view = sharedView;
      }
    }

    this.initViewExtent(view, config);
    
    // Add event listener for zoom changes
    view.on('change:resolution', () => {
      const zoom = view.getZoom();
      const scale = Math.pow(2, zoom as number);
      console.log('Zoom:', zoom, 'Scale:', scale);
    });
    
    return view;
  };

  initViewExtent(view: View, config: MapViewConfig) {
    const v = centerPointRegistry.getIfExists(config.id);
    if (v) {
      let coord: Coordinate | undefined = undefined;
      if (v.lat == null) {
        if (v.id === MapCenterID.Coordinates) {
          coord = [config.lon ?? 0, config.lat ?? 0];
        } else if (v.id === MapCenterID.Fit) {
          const extent = getLayersExtent(this.layers, config.allLayers, config.lastOnly, config.layer);
          if (!isEmpty(extent)) {
            const padding = config.padding ?? 5;
            const res = view.getResolutionForExtent(extent, this.map?.getSize());
            const maxZoom = config.zoom ?? config.maxZoom;
            view.fit(extent, {
              maxZoom: maxZoom,
            });
            view.setResolution(res * (padding / 100 + 1));
            const adjustedZoom = view.getZoom();
            if (adjustedZoom && maxZoom && adjustedZoom > maxZoom) {
              view.setZoom(maxZoom);
            }
          }
        } else {
          // TODO: view requires special handling
        }
      } else {
        coord = [v.lon ?? 0, v.lat ?? 0];
      }
      if (coord) {
        view.setCenter(fromLonLat(coord));
      }
    }

    if (config.maxZoom) {
      view.setMaxZoom(config.maxZoom);
    }
    if (config.minZoom) {
      view.setMaxZoom(config.minZoom);
    }
    if (config.zoom && v?.id !== MapCenterID.Fit) {
      view.setZoom(config.zoom);
    }
  }

  initControls(options: ControlsOptions) {
    if (!this.map) {
      return;
    }
    this.map.getControls().clear();

    if (options.showZoom) {
      this.map.addControl(new Zoom());
    }

    // Cerca il markers layer con showCustomControl abilitato
    const markersLayer = this.layers.find(layer => 
      layer.options.type === MARKERS_LAYER_ID && 
      layer.options.config && 
      (layer.options.config as MarkersConfig).showCustomControl
    );

    // Se troviamo un layer di tipo markers con showCustomControl attivato
    if (markersLayer && markersLayer.handler) {
      const config = markersLayer.options.config as MarkersConfig;
      
      // Verifica che il campo di ricerca sia definito
      if (!config.searchField) {
        console.log('Search field not configured - not adding search control');
        return; // Non aggiungere il controllo se non è stato selezionato un campo
      }
      
      const searchField = config.searchField;
      
      // Ottieni il source del layer markers per accedere alle features
      const vectorLayer = markersLayer.handler.init() as VectorLayer<any>;
      const source = vectorLayer.getSource();
      const features = source ? source.getFeatures() : [];
      
      // Ottieni lo stile originale prima di modificarlo
      const originalStyleFunction = vectorLayer.getStyle();
      
      // Funzione per applicare lo stile originale
      const applyOriginalStyle = (feature: FeatureLike, resolution: number) => {
        if (typeof originalStyleFunction === 'function') {
          return originalStyleFunction(feature, resolution);
        } else if (Array.isArray(originalStyleFunction)) {
          return originalStyleFunction;
        }
        return undefined;
      };
      
      // Funzione per aggiornare la visibilità del layer
      const updateLayerVisibility = (visibleFeatures: Feature[]) => {
        // Crea un oggetto Set con gli ID dei feature visibili
        const visibleIds = new Set();
        
        // Usa getUid per ottenere l'ID univoco invece di ol_uid
        visibleFeatures.forEach(f => {
          // Usa una proprietà più affidabile per l'identificazione
          const id = getUid(f); // Importa getUid da 'ol'
          visibleIds.add(id);
        });
        
        console.log(`Showing ${visibleIds.size} markers out of ${features.length}`);
        
        // Applica la funzione di stile modificata
        vectorLayer.setStyle((feature, resolution) => {
          const id = getUid(feature);
          if (visibleIds.has(id)) {
            // Usa lo stile originale per i feature visibili
            return applyOriginalStyle(feature, resolution);
          } else {
            return new Style({}); // Stile vuoto invece di null per nascondere la feature
          }
        });
      };
      
      // Crea il controllo di ricerca
      const customControl = new CustomControl({
        searchField: searchField,
        features: features,
        onSearchResults: (results, searchTerm) => {
          console.log(`Search found ${results.length} results for term: "${searchTerm}"`);
          
          // Se il termine di ricerca è vuoto, mostra tutti i marker
          if (!searchTerm) {
            console.log('Empty search - showing all features');
            vectorLayer.setStyle(originalStyleFunction);
            return;
          }
          
          // Se ci sono risultati, mostra solo quelli
          if (results.length > 0) {
            console.log(`Showing ${results.length} matching features`);
            updateLayerVisibility(results);
          } 
          // Se non ci sono risultati con un termine di ricerca, nascondi tutti i marker
          else {
            console.log('No search results - hiding all features');
            // Imposta uno stile vuoto per nascondere tutti i marker
            vectorLayer.setStyle(new Style({}));
          }
          
          // Log per debug
          if (results.length > 0) {
            const feature = results[0];
            const props = feature.getProperties();
            const frame = props.frame;
            const rowIndex = props.rowIndex;
            const field = frame.fields.find((f: any) => f.name === searchField);
            const value = field ? field.values[rowIndex] : undefined;
            
            console.log(`First result: ${value} (at index ${rowIndex})`);
          }
        }
      });
      
      this.map.addControl(customControl);
    }

    if (options.showScale) {
      this.map.addControl(
        new ScaleLine({
          units: options.scaleUnits,
          minWidth: 100,
        })
      );
    }

    this.mouseWheelZoom!.setActive(Boolean(options.mouseWheelZoom));

    if (options.showAttribution) {
      this.map.addControl(new Attribution({ collapsed: true, collapsible: true }));
    }

    // Update the react overlays
    let topRight1: ReactNode[] = [];
    if (options.showMeasure) {
      topRight1 = [
        <MeasureOverlay
          key="measure"
          map={this.map}
          // Lifts menuActive state and resets tooltip state upon close
          menuActiveState={(value: boolean) => {
            this.setState({ ttipOpen: value, measureMenuActive: value });
          }}
        />,
      ];
    }

    let topRight2: ReactNode[] = [];
    if (options.showDebug) {
      topRight2 = [<DebugOverlay key="debug" map={this.map} />];
    }

    this.setState({ topRight1, topRight2 });
  }

  getLegends() {
    const legends: ReactNode[] = [];
    for (const state of this.layers) {
      if (state.handler.legend) {
        legends.push(<div key={state.options.name}>{state.handler.legend}</div>);
      }
    }

    return legends;
  }

  render() {
    let { ttip, ttipOpen, topRight1, legends, topRight2 } = this.state;
    const { options } = this.props;
    const showScale = options.controls.showScale;
    if (!ttipOpen && options.tooltip?.mode === TooltipMode.None) {
      ttip = undefined;
    }

    return (
      <>
        <Global styles={this.globalCSS} />
        <div className={styles.wrap} onMouseLeave={this.clearTooltip}>
          <div
            role="application"
            className={styles.map}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0} // Interactivity is added through the ref
            aria-label={`Navigable map`}
            ref={this.initMapRef}
          ></div>
          <GeomapOverlay
            bottomLeft={legends}
            topRight1={topRight1}
            topRight2={topRight2}
            blStyle={{ bottom: showScale ? '35px' : '8px' }}
          />
        </div>
        <GeomapTooltip ttip={ttip} isOpen={ttipOpen} onClose={this.tooltipPopupClosed} />
      </>
    );
  }
}

const styles = {
  wrap: css({
    position: 'relative',
    width: '100%',
    height: '100%',
  }),
  map: css({
    position: 'absolute',
    zIndex: 0,
    width: '100%',
    height: '100%',
  }),
};

