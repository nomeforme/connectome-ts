import { InteractiveComponent, VEILComponent } from './base-components';
import { ControlPanelComponent } from './control-panel';
import { ContentGeneratorComponent } from './content-generator';
import { createBox } from './box';
import { SpaceEvent } from '../spaces/types';
import { LLMProvider } from '../llm/llm-interface';
import { Space } from '../spaces/space';

/**
 * Component that handles box dispensing
 */
export class BoxDispenserComponent extends InteractiveComponent {
  // Declare available actions for auto-registration
  static actions = {
    dispense: 'Press the button to dispense a new box',
    setSize: {
      description: 'Set the size for new boxes',
      params: ['small', 'medium', 'large']
    },
    setColor: {
      description: 'Set the color for new boxes', 
      params: ['red', 'blue', 'green', 'rainbow']
    }
  };
  
  public controlPanel!: ControlPanelComponent;
  public contentGenerator!: ContentGeneratorComponent;
  private boxCount = 0;
  
  onMount(): void {
    // Dependencies should be injected
    if (!this.controlPanel || !this.contentGenerator) {
        console.warn('BoxDispenserComponent: dependencies not injected, attempting lookup');
        // Fallback lookup if not injected
        this.controlPanel = this.space.getComponent(ControlPanelComponent)!;
        this.contentGenerator = this.space.getComponent(ContentGeneratorComponent)!;
    }

    // Register actions
    this.registerAction('dispense', async () => this.dispenseBox());
    this.registerAction('setSize', async (params) => this.setSize(params?.value || params));
    this.registerAction('setColor', async (params) => this.setColor(params?.value || params));
    
    // Subscribe to button press event using convenience method
    this.subscribe('button:pressed');
  }
  private initializeState(): void {
    // Add initial state
  }

  async onFirstFrame(): Promise<void> {
    // Add ambient instructions
    this.addFacet({
      id: 'dispenser-instructions',
      type: 'ambient',
      scope: ['dispenser'],
      content: `Available actions:
- @dispenser.dispense() - Press the button to dispense a new box
- @dispenser.setSize("small"|"medium"|"large") - Change box size
- @dispenser.setColor("red"|"blue"|"green"|"rainbow") - Change box color`
    });
    
    // Add state facet with renderers included!
    this.addFacet({
      id: 'dispenser-state',
      type: 'state',
      displayName: 'dispenser',
      content: 'A magical box dispenser with a big red button and a control panel.',
      attributes: {
        boxesDispensed: 0
      },
      // Renderers are now functions that will be auto-converted to serializable strings
      attributeRenderers: {
        boxesDispensed: (value: number) => value > 0 ? `(${value} boxes created)` : null
      },
      transitionRenderers: {
        boxesDispensed: (newValue: number, oldValue: number) => {
          if (newValue > oldValue) {
            return `Box #${newValue} materializes with a soft whoosh! The dispenser hums with satisfaction. (${newValue} total)`;
          }
          return null;
        }
      }
    });
  }
  
  async handleEvent(event: SpaceEvent): Promise<void> {
    await super.handleEvent(event);
    
    // Handle button press
    if (event.topic === 'button:pressed') {
      await this.dispenseBox();
    }
  }
  
  private async dispenseBox(): Promise<void> {
    const settings = this.controlPanel.getSettings();
    
    // Track box count change
    const oldBoxCount = this.boxCount;
    this.boxCount++;
    this.trackPropertyChange('boxCount', oldBoxCount, this.boxCount);
    
    // Generate unique contents
    const contents = await this.contentGenerator.generateContents(
      settings.size,
      settings.color
    );
    
    // Create new box
    createBox(this.space, {
      id: `${this.boxCount}`,
      size: settings.size,
      color: settings.color,
      contents
    });
    
    // Update dispenser state - the transition renderer will handle the narrative
    this.updateState('dispenser-state', {
      attributes: {
        boxesDispensed: this.boxCount
      }
    }, 'attributesOnly');
    
    // Request agent activation by adding a facet
    this.addFacet({
      id: `agent-activation-dispenser-${Date.now()}`,
      type: 'agent-activation',
      content: 'New box dispensed',
      attributes: {
        source: 'dispenser',
        reason: 'New box dispensed',
        priority: 'normal'
      }
    });
  }
  
  private async setSize(size: string): Promise<void> {
    if (['small', 'medium', 'large'].includes(size)) {
      this.emit({
        topic: 'control:size',
        payload: size
      });
      
      this.addFacet({
        id: `size-change-${Date.now()}`,
        type: 'event',
        content: `The control panel clicks as the size dial turns to "${size}".`
      });
    }
  }
  
  private async setColor(color: string): Promise<void> {
    if (['red', 'blue', 'green', 'rainbow'].includes(color)) {
      this.emit({
        topic: 'control:color',
        payload: color
      });
      
      this.addFacet({
        id: `color-change-${Date.now()}`,
        type: 'event',
        content: `The control panel's color selector shifts to ${color} with a soft hum.`
      });
    }
  }
}

/**
 * Component that represents the dispense button
 */
export class DispenseButtonComponent extends VEILComponent {
  async onFirstFrame(): Promise<void> {
    this.addFacet({
      id: 'dispense-button',
      type: 'state',
      displayName: 'button',
      content: 'A big, inviting red button labeled "DISPENSE"'
    });
  }
  
  /**
   * Press the button
   */
  press(): void {
    this.addFacet({
      id: `button-press-${Date.now()}`,
      type: 'event',
      content: '*CLICK* The button depresses with a satisfying mechanical sound.'
    });
    
    // Emit button press event
    this.emit({
      topic: 'button:pressed',
      payload: {},
      timestamp: Date.now()
    });
  }
}

/**
 * Create a box dispenser element with all necessary components
 */
export function createBoxDispenser(space: Space, llmProvider?: LLMProvider): void {
  // Create components
  const controlPanel = new ControlPanelComponent();
  const contentGenerator = new ContentGeneratorComponent(llmProvider);
  const dispenser = new BoxDispenserComponent();
  const button = new DispenseButtonComponent();
  
  // Inject dependencies
  dispenser.controlPanel = controlPanel;
  dispenser.contentGenerator = contentGenerator;
  
  // Add all components
  space.addComponent(controlPanel);
  space.addComponent(contentGenerator);
  space.addComponent(dispenser);
  space.addComponent(button);
}
