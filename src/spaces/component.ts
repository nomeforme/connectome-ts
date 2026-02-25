import { ComponentLifecycle, EventHandler, SpaceEvent, ComponentRef, ExecutionContext } from './types';
import type { Space } from './space';
import type { VEILDelta } from '../veil/types';
import {
  createAmbientFacet,
  createStateFacet,
  createEventFacet,
  createAgentActivation
} from '../helpers/factories';
import { ComponentConstraintFacet, ConstraintFacet } from './constraints';

/**
 * Base component class
 * Similar to Unity's MonoBehaviour
 */
export abstract class Component implements ComponentLifecycle, EventHandler {
  /**
   * Direct reference to Space
   */
  space!: Space;

  /**
   * Component ID
   */
  id!: string;

  /**
   * Whether this component is enabled
   */
  private _enabled: boolean = true;
  
  /**
   * Track if we've seen the first frame
   */
  private _firstFrameSeen: boolean = false;

  /**
   * Topic subscriptions
   */
  private _subscriptions: string[] = [];

  /**
   * Declared constraints for this component.
   * Use priorityConstraint() from constraints.ts to set execution order.
   *
   * @example
   * import { priorityConstraint, ComponentPriority } from './constraints';
   *
   * class MyReceptor extends Component {
   *   constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
   * }
   */
  constraints: ConstraintFacet[] = [];

  /**
   * Topic subscriptions for execute() filtering.
   * 
   * - '*' (default): Component receives all events
   * - string[]: Component only receives events matching these topics
   * 
   * Supports wildcards: 'discord.*' matches 'discord.message', 'discord.joined', etc.
   * 
   * @example
   * class MyReceptor extends Component {
   *   topics = ['discord:*', 'panel:tools-registered'];
   * }
   */
  topics: string[] | '*' = '*';

  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Get all constraint facets for this component.
   */
  getConstraintFacets(): ComponentConstraintFacet[] {
    return [...this.constraints];
  }
  
  set enabled(value: boolean) {
    if (this._enabled === value) return;
    
    this._enabled = value;
    if (value) {
      this.onEnable?.();
    } else {
      this.onDisable?.();
    }
  }
  
  /**
   * Called when component is first created (either new or from persistence)
   * Use for basic initialization that doesn't require external resources
   */
  onInit(): void {
    // Override in subclasses
  }
  
  /**
   * Called when component is being restored from persistence
   * Use for restoration-specific setup
   */
  onRestore(): void {
    // Override in subclasses
  }
  
  /**
   * Called when component is attached to space and ready for operation
   * Use for connecting to external services, starting operations
   */
  onMount(): void {
    // Override in subclasses
  }
  
  /**
   * Called when component is removed from space
   */
  onUnmount(): void {
    // Override in subclasses
  }
  
  /**
   * Called when component is enabled
   */
  onEnable(): void {
    // Override in subclasses
  }
  
  /**
   * Called when component is disabled
   */
  onDisable(): void {
    // Override in subclasses
  }
  
  /**
   * Handle events that reach this component
   * Override to process specific events
   */
  async handleEvent(event: SpaceEvent): Promise<void> {
    // Check for first frame
    if (!this._firstFrameSeen && event.topic === 'frame:start') {
      this._firstFrameSeen = true;
      if (this.onFirstFrame) {
        await this.onFirstFrame();
      }
    }
  }
  
  /**
   * Called on the first frame after mounting
   * Override to initialize facets, state, etc.
   */
  onFirstFrame?(): void | Promise<void>;
  
  /**
   * Process the current frame event
   * Called sequentially for each component in the execution list
   * 
   * @param context The execution context containing event, state, and frame
   */
  execute(context: ExecutionContext): void {
    // No-op by default
  }

  /**
   * Get a reference from the host registry with helpful errors
   */
  protected requireReference<T>(id: string): T {
    if (!this.space) {
      throw new Error(`Component ${this.constructor.name} not mounted - cannot access references`);
    }
    
    const value = this.space.getReference(id);
    if (!value) {
      const available = this.space.listReferences();
      throw new Error(
        `Required reference '${id}' not found for ${this.constructor.name}.\n` +
        `Available references: ${available.join(', ')}\n` +
        `Hint: Ensure the reference is registered before component initialization.`
      );
    }
    
    return value as T;
  }
  
  /**
   * Get an optional reference
   */
  protected getReference<T>(id: string): T | undefined {
    return this.space?.getReference(id) as T | undefined;
  }
  
  /**
   * Internal method to attach to Space
   * Returns a promise if the component has async initialization
   */
  async _attach(space: Space, id: string, isRestoring: boolean = false): Promise<void> {
    this.space = space;
    this.id = id;
    
    // Always call onInit first
    const initResult = this.onInit();
    if (initResult !== undefined && initResult !== null && typeof (initResult as any).then === 'function') {
      await initResult;
    }
    
    // If restoring, call onRestore but delay onMount
    if (isRestoring) {
      const restoreResult = this.onRestore();
      if (restoreResult !== undefined && restoreResult !== null && typeof (restoreResult as any).then === 'function') {
        await restoreResult;
      }
      // Don't call onMount yet - wait for external services
    } else {
      // For new components, call onMount immediately
      const mountResult = this.onMount();
      if (mountResult !== undefined && mountResult !== null && typeof (mountResult as any).then === 'function') {
        await mountResult;
      }
    }
    
    if (this._enabled) {
      this.onEnable();
    }

    // FLEX: Components set their own priority - no auto-registration needed
  }
  
  /**
   * Complete mounting after restoration when external services are ready
   */
  async _completeMount(): Promise<void> {
    const mountResult = this.onMount();
    if (mountResult !== undefined && mountResult !== null && typeof (mountResult as any).then === 'function') {
      await mountResult;
    }
  }
  
  /**
   * Internal method to detach
   */
  _detach(): void {
    if (this._enabled) {
      this.onDisable();
    }
    this.onUnmount();
  }
  
  // ========== Convenience Methods ==========
  
  /**
   * Emit an event from the component (async - processed in next frame or buffered)
   */
  protected emit(event: Omit<SpaceEvent, 'source' | 'timestamp'> & { timestamp?: number }): void {
    this.space.emit({
      ...event,
      source: this.getRef(),
      timestamp: event.timestamp || Date.now()
    });
  }
  
  /**
   * Emit a synchronous event that will be processed immediately in a sub-cycle.
   * 
   * Use this for:
   * - Tool calls that need immediate results
   * - Script execution with return values
   * - Any "call and wait" pattern
   * 
   * WARNING: You are responsible for preventing infinite loops.
   * If component A emits sync → B emits sync → A emits sync... = infinite loop.
   * 
   * @param event The event to emit synchronously
   */
  protected emitSync(event: Omit<SpaceEvent, 'source' | 'timestamp' | 'sync'> & { timestamp?: number }): void {
    this.space.emit({
      ...event,
      source: this.getRef(),
      timestamp: event.timestamp || Date.now(),
      sync: true
    });
  }
  
  /**
   * Subscribe to event topics
   */
  protected subscribe(topicPattern: string): void {
    this._subscriptions.push(topicPattern);
  }

  /**
   * Check if this component is subscribed to a topic
   * Checks both legacy _subscriptions AND the new topics property
   */
  isSubscribedTo(topic: string): boolean {
    // Check legacy subscriptions first
    const legacyMatch = this._subscriptions.some(pattern => {
      if (pattern === '*') return true;
      if (pattern === topic) return true;
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return topic.startsWith(prefix);
      }
      return false;
    });
    
    if (legacyMatch) return true;
    
    // Check new topics property
    return this.matchesTopic(topic);
  }
  
  /**
   * Check if a topic matches this component's topics declaration
   */
  matchesTopic(topic: string): boolean {
    if (this.topics === '*') return true;
    
    return this.topics.some(pattern => {
      if (pattern === '*') return true;
      if (pattern === topic) return true;
      // Support wildcards: 'discord:*' matches 'discord:message'
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return topic.startsWith(prefix);
      }
      // Support wildcards: 'discord.*' matches 'discord.message'
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2) + '.';
        return topic.startsWith(prefix);
      }
      return false;
    });
  }
  
  /**
   * Optional fine-grained event filter.
   * Called after topic matching, before execute().
   * Override to add custom filtering logic.
   * 
   * @param event The event to filter
   * @returns true to process this event, false to skip
   */
  eventFilter?(event: SpaceEvent): boolean;
  
  /**
   * Get a reference to this component
   */
  public getRef(): ComponentRef {
    return {
      componentId: this.id,
      componentPath: ['root', this.id],
      componentType: this.constructor.name
    };
  }

  // ============================================
  // Component State Management (VEIL-based)
  // ============================================

  /**
   * Get this component's unique ID for state scoping
   */
  protected getComponentId(): string {
    return this.id;
  }

  /**
   * Get this component's state from VEIL
   * Returns empty object if state facet doesn't exist yet
   */
  protected getComponentState<T = Record<string, any>>(): T {
    if (!this.space || !(this.space as any).getVEILState) {
      return {} as T;
    }
    
    const veilState = (this.space as any).getVEILState().getState();
    const componentId = this.getComponentId();
    // Legacy format was "component-state:componentId:Type:Index"
    // Now simplified to "component-state:componentId"
    const stateFacet = veilState.facets.get(`component-state:${componentId}`);
    
    return (stateFacet?.state || {}) as T;
  }

  /**
   * Update this component's state in VEIL
   *
   * Uses addOperation() which applies deltas immediately during execution.
   * Works for all component types (Receptors, Transforms, Effectors, Maintainers).
   *
   * Note: Afferents should emit events instead of directly modifying state.
   *
   * @param updates - Partial state updates (deep merged)
   */
  protected updateComponentState(updates: Record<string, any>): void {
    const componentId = this.getComponentId();
    const currentState = this.getComponentState();

    this.addOperation({
      type: 'rewriteFacet',
      id: `component-state:${componentId}`,
      changes: {
        state: { ...currentState, ...updates }
      }
    });
  }

  /**
   * Replace entire component state
   */
  protected setComponentState<T = Record<string, any>>(state: T): void {
    const componentId = this.getComponentId();
    
    this.addOperation({
      type: 'rewriteFacet',
      id: `component-state:${componentId}`,
      changes: {
        state
      }
    });
  }

  /**
   * Add a VEIL operation to the current frame
   * This is the primary way components interact with VEIL state
   */
  protected addOperation(operation: VEILDelta): void {
    if (!this.space) {
      throw new Error(
        `[${this.constructor.name}] Cannot add operation - component not attached to space`
      );
    }
    
    // Phase 3: Apply immediately via Space
    if ('applyOperation' in this.space) {
      (this.space as any).applyOperation(operation);
      return;
    }
    
    const frame = (this.space as any).getCurrentFrame ? (this.space as any).getCurrentFrame() : undefined;
    if (!frame) {
      throw new Error(
        `[${this.constructor.name}] VEIL operations are only allowed during frame processing. ` +
        `Move this operation from onMount() to onFirstFrame() or an event handler.`
      );
    }
    
    frame.deltas.push(operation);
  }

  // ============================================
  // Helper methods for common operations
  // ============================================

  /**
   * Adds an ambient facet with optional ID
   * @param content - The facet content
   * @param idOrAttributes - Either a string ID or attributes object
   * @param attributes - Attributes if second param was an ID
   */
  protected addAmbient(
    content: string, 
    idOrAttributes?: string | Record<string, any>,
    attributes?: Record<string, any>
  ): void {
    let id: string;
    let attrs: Record<string, any>;
    
    if (typeof idOrAttributes === 'string') {
      id = idOrAttributes;
      attrs = attributes || {};
    } else {
      // Simple counter-based ID generation
      id = `${this.id}-ambient-${Date.now()}`;
      attrs = idOrAttributes || {};
    }
    
    const { streamId = `${this.id}:ambient`, streamType, ...metadata } = attrs;

    this.addOperation({
      type: 'addFacet',
      facet: createAmbientFacet({
        id,
        content,
        streamId,
        streamType
      })
    });
    if (Object.keys(metadata).length > 0) {
      this.addOperation({
        type: 'addFacet',
        facet: createEventFacet({
          id: `${id}-meta`,
          content: `metadata:${JSON.stringify(metadata)}`,
          source: this.id,
          eventType: 'ambient-metadata',
          metadata,
          streamId,
          streamType
        })
      });
    }
  }

  /**
   * Adds a state facet
   * @param id - The facet ID (will be prefixed with component ID)
   * @param content - The facet content  
   * @param attributes - Optional attributes
   */
  protected addState(id: string, content: string, attributes: Record<string, any> = {}): void {
    const facetId = `${this.id}-${id}`;
    this.addOperation({
      type: 'addFacet',
      facet: createStateFacet({
        id: facetId,
        content,
        entityType: 'component',
        entityId: this.id,
        state: attributes,
        scopes: []
      })
    });
  }

  /**
   * Changes/updates an existing state facet
   * @param id - The facet ID (without component prefix)
   * @param updates - Content and/or attributes to update
   */
  protected changeState(
    id: string, 
    changes: { content?: string; attributes?: Record<string, any> }
  ): void {
    const facetId = `${this.id}-${id}`;
    const delta: any = {};
    if (changes.content !== undefined) {
      delta.content = changes.content;
    }
    if (changes.attributes) {
      delta.state = changes.attributes;
    }
    this.addOperation({
      type: 'rewriteFacet',
      id: facetId,
      changes: delta
    });
  }

  /**
   * @deprecated Use changeState() instead - renamed for consistency with VEIL operations
   */
  protected updateState(
    id: string, 
    changes: { content?: string; attributes?: Record<string, any> }
  ): void {
    console.warn('updateState() is deprecated. Use changeState() for consistency with VEIL operations.');
    this.changeState(id, changes);
  }

  /**
   * Adds an event facet with proper structure
   * @param content - The event content
   * @param eventType - Optional event subtype
   * @param idOrAttributes - Either a string ID or attributes object
   * @param attributes - Attributes if third param was an ID
   */
  protected addEvent(
    content: string, 
    eventType?: string,
    idOrAttributes?: string | Record<string, any>,
    attributes?: Record<string, any>
  ): void {
    let id: string;
    let attrs: Record<string, any>;
    
    if (typeof idOrAttributes === 'string') {
      id = idOrAttributes;
      attrs = attributes || {};
    } else {
      // Simple timestamp-based ID
      id = `${this.id}-event-${Date.now()}`;
      attrs = idOrAttributes || {};
    }
    
    const { source = this.id, streamId: streamIdAttr, streamType: streamTypeAttr, ...metadata } = attrs;
    const streamId = typeof streamIdAttr === 'string' ? streamIdAttr : 'default';
    const streamType = typeof streamTypeAttr === 'string' ? streamTypeAttr : undefined;

    const facet = createEventFacet({
      id,
      content,
      source,
      eventType: eventType || 'event',
      metadata: Object.keys(metadata).length ? metadata : undefined,
      streamId,
      streamType
    });
    this.addOperation({ type: 'addFacet', facet });
  }

  /**
   * Checks if we're currently in a frame (safe to add operations)
   */
  protected inFrame(): boolean {
    return (this.space as any)?.isProcessingFrame || false;
  }

  /**
   * Requires that we're in a frame, throws descriptive error if not
   */
  protected requireFrame(): void {
    if (!this.inFrame()) {
      throw new Error(
        `[${this.constructor.name}] This operation requires an active frame. ` +
        `Make sure you're calling this during frame processing or from an event handler. ` +
        `Current frame state: ${this.space ? 'Space exists but not in frame' : 'No space found'}. ` +
        `If you need to defer operations, use this.space.requestFrame().`
      );
    }
  }

  /**
   * Helper to safely get current VEIL state
   */
  protected getVeilState() {
    return (this.space as any)?.veilState?.getState() || null;
  }

  /**
   * Defers an operation until the next frame
   * Useful for operations that need to happen outside of current frame
   * 
   * @param operation - Function to execute in next frame
   */
  protected deferToNextFrame(operation: () => void): void {
    if (!this.space) {
      throw new Error(`[${this.constructor.name}] Cannot defer operation - no space found`);
    }
    
    this.space.runNextFrame(operation);
  }

  // ============================================
  // Convenience Helpers for Facet Creation
  // ============================================

  /**
   * Emit a facet via veil:operation event
   * For Effectors/Maintainers/Afferents that can't directly add to frame
   */
  protected emitFacet(facet: import('../veil/types').Facet): void {
    this.emit({
      topic: 'veil:operation',
      payload: {
        operation: {
          type: 'addFacet',
          facet
        }
      }
    });
  }

  /**
   * Emit an agent activation (convenience)
   */
  protected activateAgent(reason: string, options?: {
    priority?: 'low' | 'normal' | 'high' | 'critical';
    source?: string;
    streamRef?: any;
  }): void {
    this.emitFacet(createAgentActivation(reason, {
      source: options?.source || this.id,
      priority: options?.priority || 'normal',
      streamRef: options?.streamRef
    }));
  }

  /**
   * Emit an event facet (convenience)
   */
  protected emitEventFacet(content: string, options?: {
    eventType?: string;
    metadata?: any;
  }): void {
    this.emitFacet(createEventFacet({
      id: `${this.id}-event-${Date.now()}`,
      content,
      source: this.id,
      eventType: options?.eventType || 'event',
      metadata: options?.metadata,
      streamId: 'default'
    }));
  }
}

// Note: VEILComponent has been consolidated - use Component directly or import from base-components.ts

