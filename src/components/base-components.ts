import { Component } from '../spaces/component';
import { SpaceEvent } from '../spaces/types';
import { Space } from '../spaces/space';
import {
  Frame,
  VEILDelta,
  Facet,
  StateFacet,
  ActionFacet
} from '../veil/types';
import { ComponentChange } from '../persistence/transition-types';
import { FacetType } from '../veil/types';
import {
  createSpeechFacet,
  createThoughtFacet,
  createActionFacet,
  createEventFacet,
  createStateFacet,
  createAmbientFacet,
  createAgentActivation
} from '../helpers/factories';

/**
 * Base component for producing VEIL operations
 */
export abstract class VEILComponent extends Component {
  // Track previous values for change detection
  private _previousValues: Map<string, any> = new Map();
  
  protected _deferredOperations?: VEILDelta[];

  /**
   * Add an operation to the current frame
   * 
   * Operations are applied immediately to VEIL state via space.applyOperation()
   * so that subsequent components in the same frame can see the changes.
   */
  protected addOperation(operation: VEILDelta): void {
    // Validate operation type
    const validOperations = ['addFacet', 'rewriteFacet', 'removeFacet'];
    if (!validOperations.includes(operation.type)) {
      console.warn(`[Component] Warning: Unsupported VEIL delta "${operation.type}". Expected one of: ${validOperations.join(', ')}`);
      return;
    }
    
    if (!this.space) {
      // Not yet attached to space - defer operation
      if (!this._deferredOperations) {
        this._deferredOperations = [];
      }
      this._deferredOperations.push(operation);
      return;
    }
    
    // Use space.applyOperation for immediate application
    // This ensures subsequent components in the same frame see the changes
    (this.space as any).applyOperation(operation);
  }
  
  /**
   * Track property change in transition
   */
  protected trackPropertyChange(propertyName: string, oldValue: any, newValue: any): void {
    const space = this.space;
    if (!space) return;
    
    const frame = space.getCurrentFrame ? space.getCurrentFrame() : undefined;
    if (!frame?.transition) return;
    
    // Component index in space components list
    const componentIndex = space.components.indexOf(this);
    if (componentIndex === -1) return;
    
    frame.transition.componentChanges.push({
      elementRef: this.getRef(),
      componentType: this.constructor.name,
      componentIndex,
      property: propertyName,
      oldValue,
      newValue
    });
  }
  
  /**
   * Set a tracked property value
   */
  protected setTrackedProperty<K extends keyof this>(key: K, value: this[K]): void {
    const oldValue = this[key];
    if (oldValue !== value) {
      this[key] = value;
      this.trackPropertyChange(key as string, oldValue, value);
    }
  }
  
  /**
   * Process any deferred operations when added to space
   * Called automatically during frame processing
   */
  protected processDeferredOperations(): void {
    if (this._deferredOperations && this._deferredOperations.length > 0 && this.space) {
      console.log(`[VEILComponent.processDeferredOperations] Processing ${this._deferredOperations.length} deferred operations`);
      const ops = this._deferredOperations;
      this._deferredOperations = undefined; // Clear before processing to prevent re-entry
      
      for (const op of ops) {
        const opInfo = op.type === 'addFacet' ? `${op.type} ${(op as any).facet?.id}` : op.type;
        console.log(`[VEILComponent.processDeferredOperations] Applying:`, opInfo);
        // Use immediate application
        (this.space as any).applyOperation(op);
      }
    }
  }
  
  /**
   * Called by Space during frame processing - override in subclasses
   * Base implementation processes deferred operations
   */
  execute(context: any): void {
    this.processDeferredOperations();
  }
  
  /**
   * Add a facet to the current frame
   */
  protected addFacet(facetDef: {
    id: string;
    type: FacetType;
    content?: string;
    displayName?: string;
    scope?: string[];
    attributes?: Record<string, any>;
    attributeRenderers?: Record<string, (value: any, oldValue?: any) => string | null>;
    transitionRenderers?: Record<string, (newValue: any, oldValue: any) => string | null>;
    children?: Facet[];
    streamId?: string;
    streamType?: string;
    agentId?: string;
    agentName?: string;
    entityType?: StateFacet['entityType'];
    entityId?: string;
  }): void {
    // Validate input
    if (!facetDef) {
      throw new Error('addFacet called with undefined facetDef');
    }
    
    if (!facetDef.id) {
      throw new Error('addFacet called without required id property');
    }
    
    if (!facetDef.type) {
      throw new Error('addFacet called without required type property');
    }
    
    // Create proper facet based on type
    let facet: Facet;
    const attrs = facetDef.attributes ?? {};
    const streamId = facetDef.streamId ?? (attrs.streamId as string) ?? 'default-stream';
    const streamType = facetDef.streamType ?? (attrs.streamType as string) ?? undefined;
    const agentId = facetDef.agentId ?? (attrs.agentId as string) ?? this.id ?? 'unknown-agent';
    const agentName = facetDef.agentName ?? (attrs.agentName as string) ?? undefined;

    switch (facetDef.type) {
      case 'event': {
        const { source = 'system', eventType = facetDef.displayName ?? 'event', ...metadata } = attrs;
        facet = createEventFacet({
          id: facetDef.id,
          content: facetDef.content ?? facetDef.displayName ?? '',
          source,
          eventType,
          metadata: Object.keys(metadata).length ? metadata : undefined,
          streamId,
          streamType
        });
        break;
      }
      case 'state': {
        const { entityType: attrEntityType, entityId: attrEntityId, state: explicitState, ...stateData } = attrs;
        const entityType = (attrEntityType as StateFacet['entityType']) ?? facetDef.entityType ?? 'component';
        const entityId = (attrEntityId as string) ?? facetDef.entityId ?? this.id ?? 'unknown-entity';
        facet = createStateFacet({
          id: facetDef.id,
          content: facetDef.content ?? facetDef.displayName ?? '',
          entityType,
          entityId,
          state: (explicitState as Record<string, any>) ?? stateData,
          scopes: facetDef.scope ?? []
        });
        break;
      }
      case 'ambient': {
        facet = createAmbientFacet({
          id: facetDef.id,
          content: facetDef.content ?? facetDef.displayName ?? '',
          streamId,
          streamType
        });
        break;
      }
      case 'speech': {
        facet = createSpeechFacet({
          id: facetDef.id,
          content: facetDef.content ?? '',
          agentId,
          agentName,
          streamId,
          streamType
        });
        break;
      }
      case 'thought': {
        facet = createThoughtFacet({
          id: facetDef.id,
          content: facetDef.content ?? '',
          agentId,
          agentName,
          streamId,
          streamType
        });
        break;
      }
      case 'action': {
        const { toolName: attrToolName, parameters: attrParameters, ...rest } = attrs;
        const toolName = (attrToolName as string) ?? facetDef.displayName ?? 'action';
        const parameters = (attrParameters as Record<string, any>) ?? {};
        facet = createActionFacet({
          id: facetDef.id,
          content: facetDef.content ?? `@${toolName}`,
          toolName,
          parameters,
          agentId,
          agentName,
          streamId,
          streamType
        }) as ActionFacet;
        if (Object.keys(rest).length > 0) {
          (facet.state as any).metadata = rest;
        }
        break;
      }
      case 'action-definition':
      case 'tool': {
        // action-definition is metadata, not agent-generated content
        // Don't use createActionFacet - preserve type as-is
        facet = {
          id: facetDef.id,
          type: facetDef.type,
          displayName: facetDef.displayName,
          attributes: facetDef.attributes,
          children: facetDef.children
        } as Facet;
        break;
      }
      case 'agent-activation': {
        const { reason: attrReason, priority: attrPriority, sourceAgentId: attrSourceAgentId, ...rest } = attrs;
        const reason = facetDef.content ?? (attrReason as string) ?? 'Activation';
        facet = createAgentActivation(reason, {
          id: facetDef.id,
          priority: attrPriority as any,
          sourceAgentId: attrSourceAgentId as string,
          ...rest
        });
        break;
      }
      default:
        throw new Error(`Invalid facet type: ${(facetDef as any).type}`);
    }

    this.addOperation({
      type: 'addFacet',
      facet
    });
  }
  
  /**
   * Update a state facet
   */
  protected updateState(
    id: string,
    changes: {
      content?: string;
      state?: Record<string, any>;
      attributes?: Record<string, any>;
    },
    updateMode?: 'full' | 'attributesOnly'
  ): void {
    const { content, state, attributes } = changes;
    const nextState = state ?? attributes ?? {};

    const delta: any = {};
    if (content !== undefined) {
      delta.content = content;
    }
    if (Object.keys(nextState).length > 0) {
      delta.state = nextState;
    }

    this.addOperation({
      type: 'rewriteFacet',
      id,
      changes: delta
    });
  }
}

/**
 * Base component for handling interactions
 */
export abstract class InteractiveComponent extends VEILComponent {
  /**
   * Static property for declaring component actions
   * Components should override this to declare their available actions
   */
  static actions?: Record<string, string | { description: string; params?: any }>;
  
  protected actions: Map<string, (params?: any) => Promise<void>> = new Map();
  
  /**
   * Register an action handler and create action-definition facet (deferred to next frame)
   */
  protected registerAction(
    name: string, 
    handler: (params?: any) => Promise<void>,
    config?: { description?: string; params?: any }
  ): void {
    this.actions.set(name, handler);
    
    // Defer facet creation to next frame (onMount happens outside frame processing)
    const toolName = `${this.id}.${name}`;
    if (!this._deferredOperations) {
      this._deferredOperations = [];
    }
    this._deferredOperations.push({
      type: 'addFacet',
      facet: {
        id: `action-def-${this.id}-${name}`,
        type: 'action-definition',
        // No content - action-definition is metadata, not renderable to LLM
        displayName: toolName,
        attributes: {
          toolName,
          actionName: name,
          componentId: this.id,
          parameters: config?.params || {},
          description: config?.description || `Perform ${name} action`
        }
      } as Facet
    });
  }
  
  /**
   * Register action with instructions - creates both action-definition AND instruction facet
   * 
   * @param name - Action name
   * @param handler - Action handler function
   * @param instructions - Renderable instructions for the agent
   * @param config - Optional config (description, params, scope)
   */
  protected registerActionWithInstructions(
    name: string,
    handler: (params?: any) => Promise<void>,
    instructions: string,
    config?: { 
      description?: string; 
      params?: any;
      scope?: string[];  // For control panels: ["panel:discord-control"]
      category?: string;
    }
  ): void {
    // Register the action (creates action-definition)
    this.registerAction(name, handler, config);
    
    // Create instruction facet (renderable to agent)
    const toolName = `${this.id}.${name}`;
    if (!this._deferredOperations) {
      this._deferredOperations = [];
    }
    this._deferredOperations.push({
      type: 'addFacet',
      facet: {
        id: `tool-instruction-${this.id}-${name}`,
        type: 'event',
        displayName: 'tool-instruction',
        content: instructions,
        state: {
          source: this.id,
          eventType: 'tool-instruction',
          metadata: {
            toolName,
            actionName: name,
            category: config?.category || this.id
          }
        },
        scope: config?.scope
      } as Facet
    });
  }
  
  /**
   * Handle incoming events
   */
  async handleEvent(event: SpaceEvent): Promise<void> {
    // Call parent to handle first frame
    await super.handleEvent(event);
  }
}

/**
 * Base component for managing state
 */
export abstract class StateComponent<T = any> extends VEILComponent {
  protected state: T;
  protected stateId: string;
  
  constructor(initialState: T, stateId: string) {
    super();
    this.state = initialState;
    this.stateId = stateId;
  }
  
  /**
   * Update state and emit VEIL operation
   */
  protected setState(changes: Partial<T>): void {
    // Track individual property changes
    for (const [key, newValue] of Object.entries(changes)) {
      const oldValue = this.state[key as keyof T];
      if (oldValue !== newValue) {
        this.trackPropertyChange(`state.${key}`, oldValue, newValue);
      }
    }
    
    this.state = { ...this.state, ...changes };
    this.emitStateUpdate();
  }
  
  /**
   * Get current state
   */
  getState(): T {
    return this.state;
  }
  
  /**
   * Emit state update to VEIL
   */
  protected abstract emitStateUpdate(): void;
}

/**
 * Helper to create a component with minimal boilerplate
 */
export function createComponent<T extends Component>(
  setup: (component: T) => void
): T {
  const ComponentClass = class extends Component {
    constructor() {
      super();
      setup(this as any);
    }
  };
  return new ComponentClass() as T;
}
