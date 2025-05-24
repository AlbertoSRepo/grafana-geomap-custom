import { Control } from 'ol/control';
import { Feature } from 'ol';
import { debounce } from 'lodash';

export interface CustomControlOptions {
  searchField?: string;
  features?: Feature[];
  onSearchResults?: (results: Feature[], searchTerm: string) => void;
  target?: HTMLElement | string;
}

export class CustomControl extends Control {
  private inputElement: HTMLInputElement;
  private searchField?: string;
  private features: Feature[] = [];
  private onSearchResults?: (results: Feature[], searchTerm: string) => void;
  private debouncedSearch: (searchTerm: string) => void;
  
  constructor(options: CustomControlOptions = {}) {
    const element = document.createElement('div');
    element.className = 'ol-custom-control ol-unselectable ol-control';
    
    // Posizionamento del controllo a destra
    element.style.position = 'absolute';
    element.style.right = '10px';
    element.style.top = '10px';
    
    // Creiamo un contenitore per input e bottone
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'flex-end';
    element.appendChild(container);
    
    // Creiamo l'elemento input (inizialmente nascosto)
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `Search in ${options.searchField || 'field'}...`;
    input.className = 'custom-control-input';
    input.style.display = 'none';
    input.style.marginRight = '5px';
    input.style.padding = '4px';
    input.style.width = '150px';
    container.appendChild(input);
    
    // Creiamo l'elemento bottone con stili migliorati
    const button = document.createElement('button');
    button.innerHTML = '🔍';
    button.className = 'custom-control-button';
    // Aggiungiamo stili espliciti per renderlo visibile
    button.style.backgroundColor = 'white';
    button.style.border = '1px solid #ccc';
    button.style.borderRadius = '4px';
    button.style.padding = '4px 8px';
    button.style.cursor = 'pointer';
    button.style.fontSize = '16px';
    button.style.width = '32px';
    button.style.height = '32px';
    button.style.display = 'flex';
    button.style.alignItems = 'center';
    button.style.justifyContent = 'center';
    container.appendChild(button);

    super({
      element: element,
      target: options.target,
    });
    
    this.inputElement = input;

    this.searchField = options.searchField;
    this.features = options.features || [];
    this.onSearchResults = options.onSearchResults;

    // Crea la funzione di ricerca debounced
    this.debouncedSearch = debounce(this.performSearch.bind(this), 300);

    // Aggiungiamo gli event listener
    button.addEventListener('click', this.handleButtonClick.bind(this));
    input.addEventListener('input', this.handleInputChange.bind(this));
    input.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  handleButtonClick(event: Event) {
    event.stopPropagation();
    
    // Alterna la visibilità dell'input
    if (this.inputElement.style.display === 'none') {
      this.inputElement.style.display = 'block';
      this.inputElement.focus();
    } else {
      this.inputElement.style.display = 'none';
      this.inputElement.value = '';
      // Resetta la ricerca quando si chiude - mostra nuovamente tutti i markers
      this.performSearch('');
    }
  }

  handleInputChange(event: Event) {
    const target = event.target as HTMLInputElement;
    this.debouncedSearch(target.value);
  }

  handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.performSearch(this.inputElement.value);
    } else if (event.key === 'Escape') {
      this.inputElement.style.display = 'none';
      this.inputElement.value = '';
      this.performSearch('');
    }
  }

  performSearch(searchTerm: string) {
    if (!this.searchField || !this.features.length) {
      console.log('No search field configured or no features available');
      return;
    }

    // Se il termine di ricerca è vuoto, mostra tutti i markers
    if (!searchTerm.trim()) {
      console.log('Search cleared - showing all markers');
      this.onSearchResults?.(this.features, '');
      return;
    }

    // Esegui la ricerca sui features
    const results = this.features.filter((feature) => {
      const properties = feature.getProperties();
      
      // Accedi ai campi nel frame usando rowIndex
      if (properties.frame && typeof properties.rowIndex === 'number') {
        const frame = properties.frame;
        const rowIndex = properties.rowIndex;
        
        // Trova il campo con il nome specificato
        const field = frame.fields.find((f: any) => f.name === this.searchField);
        
        if (field && field.values && field.values[rowIndex] !== undefined) {
          const fieldValue = field.values[rowIndex];
          
          if (typeof fieldValue === 'string') {
            return fieldValue.toLowerCase().startsWith(searchTerm.toLowerCase());
          } else if (fieldValue !== null && fieldValue !== undefined) {
            return String(fieldValue).toLowerCase().startsWith(searchTerm.toLowerCase());
          }
        }
      }
      
      return false;
    });

    // Stampa i risultati in console
    console.log(`Search results for "${searchTerm}" in field "${this.searchField}":`, results);
    console.log(`Found ${results.length} markers matching the search criteria`);
    
    // Log dettagliato dei risultati
    results.forEach((feature, index) => {
      const properties = feature.getProperties();
      const frame = properties.frame;
      const rowIndex = properties.rowIndex;
      const field = frame.fields.find((f: any) => f.name === this.searchField);
      const value = field ? field.values[rowIndex] : undefined;
      
      console.log(`Result ${index + 1}:`, {
        searchField: this.searchField,
        searchValue: value,
        rowIndex: rowIndex
      });
    });

    // Chiama il callback con il termine di ricerca
    this.onSearchResults?.(results, searchTerm.trim());
  }

  // Metodi per aggiornare i dati dal layer
  updateSearchField(searchField: string) {
    this.searchField = searchField;
    this.inputElement.placeholder = `Search in ${searchField}...`;
  }

  updateFeatures(features: Feature[]) {
    this.features = features;
  }
}