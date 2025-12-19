import { Component } from '../spaces/component';
import { Space } from '../spaces/space';
import { StateComponent, InteractiveComponent } from './base-components';
import { SpaceEvent } from '../spaces/types';

/**
 * Box configuration
 */
export interface BoxConfig {
  id: string;
  size: 'small' | 'medium' | 'large';
  color: 'red' | 'blue' | 'green' | 'rainbow';
  contents?: string;
}

/**
 * Box state
 */
interface BoxState {
  isOpen: boolean;
  size: string;
  color: string;
  contents: string;
}

/**
 * Component that manages box state and VEIL
 */
export class BoxStateComponent extends StateComponent<BoxState> {
  constructor(config: BoxConfig) {
    super({
      isOpen: false,
      size: config.size,
      color: config.color,
      contents: config.contents || 'Something mysterious'
    }, `box-${config.id}-state`);
  }
  
  onFirstFrame(): void {
    // Initialize state facet
    this.addFacet({
      id: this.stateId,
      type: 'state',
      displayName: 'box_info',
      content: this.getStateDescription(),
      attributes: this.state
    });
  }
  
  protected emitStateUpdate(): void {
    this.updateState(this.stateId, {
      content: this.getStateDescription(),
      attributes: this.state
    });
  }
  
  private getStateDescription(): string {
    const { isOpen, size, color, contents } = this.state;
    if (isOpen) {
      return `The ${size} ${color} box is open, revealing ${contents}!`;
    }
    return `A ${size} ${color} box sits here, closed and mysterious.`;
  }
  
  open(): void {
    if (!this.state.isOpen) {
      this.setState({ isOpen: true });
      
      // Emit event facet for the opening
      this.addFacet({
        id: `${this.stateId}-opened-${Date.now()}`,
        type: 'event',
        content: `💥 The ${this.state.color} box opens with a ${this.getOpeningEffect()}!`
      });
    }
  }
  
  private getOpeningEffect(): string {
    switch (this.state.color) {
      case 'red': return 'burst of flame';
      case 'blue': return 'splash of water';
      case 'green': return 'shower of leaves';
      case 'rainbow': return 'cascade of rainbow sparkles';
      default: return 'puff of smoke';
    }
  }
}

/**
 * Component that handles box interactions
 */
class BoxInteractionComponent extends InteractiveComponent {
  // Declare available actions for auto-registration
  static actions = {
    open: {
      description: 'Open this mysterious box',
      params: { 
        type: 'object',
        properties: {
          method: { 
            type: 'string', 
            enum: ['gently', 'forcefully', 'carefully'],
            description: 'How to open the box'
          }
        }
      }
    }
  };
  
  private stateComponent!: BoxStateComponent;
  private stateComponentId: string;

  constructor(stateComponentId: string) {
    super();
    this.stateComponentId = stateComponentId;
  }
  
  onMount(): void {
    const comp = this.space.getComponentById(this.stateComponentId);
    if (!comp || !(comp instanceof BoxStateComponent)) {
        throw new Error(`BoxInteractionComponent could not find state component ${this.stateComponentId}`);
    }
    this.stateComponent = comp;
    
    // Register open action
    this.registerAction('open', async (params) => {
      await this.openBox(params?.method || 'normally');
    });
    
    // No need to subscribe to element:action - base Element handles this
  }
  
  async onFirstFrame(): Promise<void> {
    const state = this.stateComponent.getState();
    if (!state.isOpen) {
      this.addFacet({
        id: `${this.id}-actions`,
        type: 'ambient',
        scope: [this.id],
        content: `You can open this box with @${this.id}.open()`
      });
    }
  }
  
  async openBox(method: string): Promise<void> {
    const state = this.stateComponent.getState();
    
    if (state.isOpen) {
      this.addFacet({
        id: `box-${this.id}-already-open`,
        type: 'event',
        content: 'The box is already open!'
      });
      return;
    }
    
    // Open the box
    this.stateComponent.open();
    
    // Request agent activation for high-priority reaction
    this.addFacet({
      id: `agent-activation-box-${Date.now()}`,
      type: 'agent-activation',
      content: `Box opened ${method}`,
      attributes: {
        source: this.id,
        reason: `Box opened ${method}`,
        priority: 'high'
      }
    });
  }
}

/**
 * Create a box element with state and interaction components
 */
export function createBox(space: Space, config: BoxConfig): void {
  const boxId = `box-${config.id}`;
  
  // Create components
  const stateComp = new BoxStateComponent(config);
  const stateId = `${boxId}-state`;
  
  const interactComp = new BoxInteractionComponent(stateId);
  
  // Add to space with specific IDs
  space.addComponent(stateComp, stateId);
  space.addComponent(interactComp, `${boxId}-interaction`);
}

// For backwards compatibility, export Box as the factory function
export const Box = createBox;
