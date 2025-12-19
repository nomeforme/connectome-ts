import { Component } from './component';
import { SpaceEvent, FrameStartEvent, FrameEndEvent, StreamRef, ComponentRef, SubCycleInfo, SubCycleConfig } from './types';
import { VEILStateManager } from '../veil/veil-state';
import { Frame, Facet, VEILDelta, AgentInfo, createDefaultTransition } from '../veil/types';
import { 
  TraceStorage, 
  TraceCategory, 
  getGlobalTracer 
} from '../tracing';
import { EventPriorityQueue } from './priority-queue';
import type { 
  DebugObserver,
  DebugFrameStartContext,
  DebugFrameCompleteContext,
  DebugEventContext,
  DebugAgentFrameContext
} from '../debug/types';
import { DebugServer, DebugServerConfig } from '../debug/debug-server';
import { deterministicUUID } from '../utils/uuid';
import { performance } from 'perf_hooks';
import { 
  Modulator,
  Receptor, 
  Transform, 
  Effector, 
  FacetDelta, 
  ReadonlyVEILState,
  EffectorResult,
  FacetFilter,
  Maintainer
} from './receptor-effector-types';
import { VEILOperationReceptor } from './migration-adapters';
import { ActivationCompletedReceptor } from '../agent/activation-completed-receptor';
import { groupByPriority } from '../utils/priorities';
// Legacy RETM type guards - kept for backwards compatibility but not used in FLEX
// import { isReceptor, isTransform, isEffector, isMaintainer, isModulator } from '../utils/retm-type-guards';
import { generateId } from './utils';
import {
  ComponentOrderingStrategy,
  PriorityOrderingStrategy,
  MultiConstraintOrderingStrategy,
  MultiConstraintOrderingOptions
} from './ordering/component-ordering';
import { ComponentConstraintFacet, ConstraintFacet, priorityConstraint } from './constraints';

/**
 * The root Space that orchestrates the entire system
 */
export class Space {
  /**
   * Unique identifier for this Space
   */
  readonly id: string;

  /**
   * Human-readable name
   */
  name: string = 'root';

  /**
   * Flat list of all components in the system
   */
  components: Component[] = [];

  /**
   * Component ID registry for fast lookup
   */
  private componentRegistry: Map<string, Component> = new Map();

  /**
   * Priority event queue for the current frame
   */
  private eventQueue: EventPriorityQueue = new EventPriorityQueue();
  
  /**
   * Reference to the host's registry (single source of truth)
   */
  private hostRegistry: Map<string, any>;
  
  /**
   * VEIL state manager
   */
  private veilState: VEILStateManager;
  
  /**
   * Current frame being processed
   */
  private currentFrame?: Frame;
  
  /**
   * Active stream reference
   */
  private activeStream?: StreamRef;
  
  /**
   * Whether we're currently processing a frame
   */
  private processingFrame: boolean = false;

  /**
   * Whether a frame is already scheduled but hasn't started yet
   */
  private frameScheduled: boolean = false;

  /**
   * Tracer for observability
   */
  private tracer: TraceStorage | undefined;
  
  /**
   * Registered debug observers that mirror internal activity to external tooling
   */
  private debugObservers: DebugObserver[] = [];
  
  private debugServerInstance?: DebugServer;
  
  // Frame event buffer for sequential execution
  private frameEventBuffer: SpaceEvent[] = [];
  
  // Lifecycle ID - persists for the entire life of this Space instance
  public readonly lifecycleId: string;
  
  // Restoration mode - suppresses event processing during state restoration
  private isRestoring: boolean = false;
  
  // Topic subscriptions for the Space itself
  private _subscriptions: string[] = [];

  // Callbacks to run on next frame
  private nextFrameCallbacks: (() => void)[] = [];

  // Default to multi-constraint ordering to support before/after constraints
  private componentOrderingStrategy: ComponentOrderingStrategy = new MultiConstraintOrderingStrategy();

  // Sub-cycle configuration
  private subCycleConfig: Required<SubCycleConfig> = {
    maxDepth: 10,
    warningDepth: 5,
    onMaxDepthExceeded: 'error',
    fullCycle: true
  };
  
  // Current sub-cycle depth (0 = main cycle, 1+ = sub-cycles)
  private currentSubCycleDepth: number = 0;
  
  // Sub-cycle trace for current frame
  private currentSubCycleTrace: SubCycleInfo[] = [];
  
  // Currently executing component index (for partial cycle sub-cycles)
  private currentComponentIndex: number = 0;

  /**
   * Runtime flag to enable detailed component execution tracing
   * Enabled by default to provide per-component delta attribution
   */
  public enableComponentTracing: boolean = true;

  /**
   * Options for Space configuration
   */
  static readonly OrderingStrategy = {
    /** Simple priority-based ordering (default, backward compatible) */
    PRIORITY: 'priority',
    /** Multi-constraint ordering with graph-based resolution */
    MULTI_CONSTRAINT: 'multi-constraint'
  } as const;

  constructor(
    veilState: VEILStateManager,
    hostRegistry?: Map<string, any>,
    lifecycleId?: string,
    spaceId?: string,
    options?: {
      /** Ordering strategy: 'priority' (default) or 'multi-constraint' */
      orderingStrategy?: 'priority' | 'multi-constraint';
      /** Options for multi-constraint ordering (only used if orderingStrategy is 'multi-constraint') */
      multiConstraintOptions?: MultiConstraintOrderingOptions;
      /** Sub-cycle configuration for sync event processing */
      subCycle?: SubCycleConfig;
    }
  ) {
    this.id = spaceId || 'root';
    this.veilState = veilState;
    this.hostRegistry = hostRegistry || new Map(); // Fallback for tests
    this.tracer = getGlobalTracer();
    this.lifecycleId = lifecycleId || this.generateLifecycleId();

    // Configure ordering strategy (default is multi-constraint, supports before/after)
    if (options?.orderingStrategy === 'priority') {
      this.componentOrderingStrategy = new PriorityOrderingStrategy();
    } else if (options?.multiConstraintOptions) {
      // Apply options to the default multi-constraint strategy
      this.componentOrderingStrategy = new MultiConstraintOrderingStrategy(
        options.multiConstraintOptions
      );
    }
    
    // Configure sub-cycle behavior
    if (options?.subCycle) {
      this.subCycleConfig = {
        ...this.subCycleConfig,
        ...options.subCycle
      };
    }

    // Subscribe to agent activation events
    this.subscribe('agent:activate');

    // Add built-in receptors
    const veilOpReceptor = new VEILOperationReceptor();
    this.addComponent(veilOpReceptor);

    const activationCompletedReceptor = new ActivationCompletedReceptor();
    this.addComponent(activationCompletedReceptor);
  }
  
  /**
   * Enable/disable component execution tracing
   */
  toggleComponentTracing(enabled: boolean): void {
    this.enableComponentTracing = enabled;
  }

  /**
   * Set the component ordering strategy.
   * This will re-sort all components using the new strategy.
   */
  setOrderingStrategy(strategy: ComponentOrderingStrategy): void {
    this.componentOrderingStrategy = strategy;
    this.sortComponents();
  }

  /**
   * Get the current ordering strategy
   */
  getOrderingStrategy(): ComponentOrderingStrategy {
    return this.componentOrderingStrategy;
  }
  
  /**
   * Configure sub-cycle behavior at runtime
   */
  setSubCycleConfig(config: Partial<SubCycleConfig>): void {
    this.subCycleConfig = {
      ...this.subCycleConfig,
      ...config
    };
  }
  
  /**
   * Get the current sub-cycle configuration
   */
  getSubCycleConfig(): Readonly<Required<SubCycleConfig>> {
    return this.subCycleConfig;
  }

  /**
   * Get VEILStateManager - public accessor for components
   */
  getVEILStateManager(): VEILStateManager {
    return this.veilState;
  }
  
  /**
   * Generate a new lifecycle ID for this Space instance
   */
  private generateLifecycleId(): string {
    return `lifecycle-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Add a component to the Space
   */
  addComponent<T extends Component>(
    component: T,
    componentId?: string,
    isRestoring: boolean = false,
    options?: {
      priority?: number;
      constraints?: ConstraintFacet[];
      after?: Component | string;
      before?: Component | string;
    }
  ): T {
    // Generate stable ID if not provided
    const id = componentId || `component-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Check for duplicate ID
    if (this.componentRegistry.has(id)) {
      console.warn(`[Space.addComponent] Component ID ${id} already registered, skipping`);
      return this.componentRegistry.get(id) as T;
    }

    // Inject constraints if provided via options
    if (options?.constraints && options.constraints.length > 0) {
      component.constraints = [...options.constraints, ...component.constraints];
    } else if (options?.priority !== undefined) {
      // Legacy: convert priority option to constraint
      component.constraints = [
        priorityConstraint(options.priority, 'addComponent:options'),
        ...component.constraints
      ];
    }

    // Handle insertion constraints
    let insertIndex = -1;
    
    if (options?.after) {
       // Insert after specific component
       const target = typeof options.after === 'string' 
         ? this.getComponentById(options.after) 
         : options.after;
       if (target) {
         const idx = this.components.indexOf(target);
         if (idx !== -1) insertIndex = idx + 1;
       }
    } else if (options?.before) {
       // Insert before specific component
       const target = typeof options.before === 'string'
         ? this.getComponentById(options.before)
         : options.before;
       if (target) {
         const idx = this.components.indexOf(target);
         if (idx !== -1) insertIndex = idx;
       }
    } else if (options?.after === 'current') {
        // Insert after currently executing component (if processing frame)
        // We need to track current component index in processFrame
        // For now, append to end if not in frame, or use specific logic if needed
    }

    // Register component
    if (insertIndex !== -1) {
      this.components.splice(insertIndex, 0, component);
    } else {
      this.components.push(component);
    }
    
    // Sort by priority if no explicit position constraints were used to force order?
    // Or always sort? If we sort, 'after'/'before' might be lost if priorities conflict.
    // For Phase 3, let's assume priority dominates unless explicit position is given.
    // If we didn't insert at specific index, we sort.
    if (insertIndex === -1) {
      this.sortComponents();
    }

    this.componentRegistry.set(id, component);
    this.updateConstraintFacetsForComponent(id, component);

    // Mount to Space
    // _attach will call onInit, onMount/onRestore, and auto-register MARTEMs
    // We don't await it here to match synchronous add behavior, but it handles async init internally
    component
      ._attach(this, id, isRestoring)
      .then(() => {
        this.refreshConstraintFacets();
      })
      .catch((err: any) => {
        console.error(`[Space.addComponent] Error attaching component ${id}:`, err);
      });

    console.log(`[Space.addComponent] Registered ${component.constructor.name} (${id})`);

    return component;
  }

  /**
   * Complete mounting after restoration when external services are ready
   */
  async completeMountForRestoration(): Promise<void> {
    // For flat components list
    for (const component of this.components) {
       if ('_completeMount' in component) {
         await (component as any)._completeMount();
       }
    }
  }
  
  /**
   * Remove a component from the Space
   */
  removeComponent(component: Component): boolean {
    const index = this.components.indexOf(component);
    if (index === -1) return false;
    
    this.components.splice(index, 1);
    if (component.id) {
      this.componentRegistry.delete(component.id);
    }
    
    component._detach();
    return true;
  }

  /**
   * Get a component by its unique ID
   */
  getComponentById(id: string): Component | undefined {
    return this.componentRegistry.get(id);
  }

  /**
   * Get the first component of a specific type
   */
  getComponent<T extends Component>(type: new (...args: any[]) => T): T | null {
    return this.components.find(c => c instanceof type) as T || null;
  }

  /**
   * Get all components of a specific type
   */
  getComponents<T extends Component>(type: new (...args: any[]) => T): T[] {
    return this.components.filter(c => c instanceof type) as T[];
  }
  
  /**
   * Request a frame (alias for legacy support, or for external callers)
   */
  requestFrame(): void {
    if (!this.processingFrame && !this.frameScheduled) {
      this.frameScheduled = true;
      setImmediate(() => {
        this.frameScheduled = false;
        this.processFrame();
      });
    }
  }

  /**
   * Sort components by priority
   */
  private sortComponents(): void {
    const ordered = this.componentOrderingStrategy.order([...this.components]);
    this.components.splice(0, this.components.length, ...ordered);
    this.refreshConstraintFacets();
  }

  private updateConstraintFacetsForComponent(componentId: string, component: Component): void {
    try {
      const constraints = component.getConstraintFacets().map(facet => ({ ...facet }));
      const parentFacetId = `component-state:${componentId}`;
      const constraintsFacetId = `constraints:${componentId}`;

      // Get or create the parent component-state facet
      const parentFacet = this.veilState.getState().facets.get(parentFacetId);

      // Create the constraints child facet
      const constraintsChildFacet = {
        id: constraintsFacetId,
        type: 'component-constraints',
        state: { constraints }
      };

      if (parentFacet) {
        // Update existing parent facet with constraints as nested child
        const existingChildren = (parentFacet as any).children || [];
        const otherChildren = existingChildren.filter((c: any) => c.id !== constraintsFacetId);

        this.veilState.applyDeltasDirect([{
          type: 'rewriteFacet',
          id: parentFacetId,
          changes: {
            children: [...otherChildren, constraintsChildFacet]
          }
        }]);
      } else {
        // Create new component-state facet with constraints nested inside
        const componentType = component.constructor.name || 'Unknown';

        this.veilState.applyDeltasDirect([{
          type: 'addFacet',
          facet: {
            id: parentFacetId,
            type: 'component-state',
            componentType,
            componentId,
            parentId: 'root', // Components are attached to Space (root)
            state: {},
            children: [constraintsChildFacet]
          }
        }]);
      }
    } catch (error) {
      console.warn(
        `[Space] Failed to capture constraint facets for ${componentId}:`,
        error
      );
    }
  }

  private refreshConstraintFacets(): void {
    for (const [componentId, component] of this.componentRegistry.entries()) {
      this.updateConstraintFacetsForComponent(componentId, component);
    }
  }

  /**
   * Get constraint facets for a component from VEIL state
   */
  getConstraintFacetsForComponent(componentId: string): ComponentConstraintFacet[] {
    const parentFacetId = `component-state:${componentId}`;
    const constraintsFacetId = `constraints:${componentId}`;
    const parentFacet = this.veilState.getState().facets.get(parentFacetId);

    if (!parentFacet) return [];

    const constraintsChild = (parentFacet as any).children?.find(
      (c: any) => c.id === constraintsFacetId
    );

    return constraintsChild?.state?.constraints || [];
  }

  /**
   * Apply a VEIL operation immediately
   * Called by components during execution
   */
  applyOperation(operation: VEILDelta): void {
    if (!this.processingFrame || !this.currentFrame) {
      console.warn('[Space] applyOperation called outside of frame processing');
      return;
    }

    console.log(`[Space.applyOperation] Applying ${operation.type} delta immediately`);

    // Apply to VEIL state
    this.veilState.applyDeltasDirect([operation]);

    // Record in frame
    this.currentFrame.deltas.push(operation);
  }

  /**
   * Attach an external debug observer
   */
  addDebugObserver(observer: DebugObserver): void {
    this.debugObservers.push(observer);
  }
  
  /**
   * Enable embedded debug server
   */
  enableDebugServer(config?: Partial<DebugServerConfig>): void {
    if (this.debugServerInstance) {
      return;
    }
    this.debugServerInstance = new DebugServer(this, config);
    this.debugServerInstance.start();
  }

  /**
   * Get the current active stream
   */
  getActiveStream(): StreamRef | undefined {
    return this.activeStream;
  }
  
  /**
   * Get the current frame
   */
  getCurrentFrame(): Frame | undefined {
    return this.currentFrame;
  }
  
  /**
   * Set restoration mode
   */
  setRestorationMode(restoring: boolean): void {
    this.isRestoring = restoring;
  }
  
  /**
   * Queue an event for processing
   */
  queueEvent(event: SpaceEvent): void {
    // Suppress event processing during restoration
    if (this.isRestoring) {
      return;
    }
    
    // Queue events that arrive during frame processing
    // These will be added to the main queue at the end of the current frame
    if (this.processingFrame) {
      this.frameEventBuffer.push(event);
    } else {
      this.eventQueue.push(event);
      this.requestFrame();
    }
    
    this.tracer?.record({
      id: `evt-${Date.now()}`,
      timestamp: Date.now(),
      level: 'debug',
      category: TraceCategory.EVENT_QUEUE,
      component: 'Space',
      operation: 'queueEvent',
      data: {
        topic: event.topic,
        source: event.source.componentId,
        priority: event.priority || 'normal',
        queueLength: this.eventQueue.length,
        queueState: this.eventQueue.getDebugInfo()
      }
    });
    
    this.requestFrame();
  }
  
  /**
   * Emit an event
   */
  emit(event: SpaceEvent): void {
    // Handle sync events differently - they trigger sub-cycles
    if (event.sync && this.processingFrame) {
      this.processSubCycle(event);
    } else {
      this.queueEvent(event);
    }
  }
  
  /**
   * Process a sync event in a sub-cycle
   */
  private processSubCycle(event: SpaceEvent): void {
    const startDepth = this.currentSubCycleDepth + 1;
    
    // Check depth limit
    if (startDepth > this.subCycleConfig.maxDepth) {
      if (this.subCycleConfig.onMaxDepthExceeded === 'error') {
        throw new Error(
          `[Space] Sub-cycle depth limit exceeded (${startDepth} > ${this.subCycleConfig.maxDepth}). ` +
          `This usually indicates an infinite loop in sync event emission. ` +
          `Check components that emit sync events for cycles.`
        );
      } else {
        console.warn(
          `[Space] Sub-cycle depth limit exceeded (${startDepth} > ${this.subCycleConfig.maxDepth}). ` +
          `Forcing event to buffer instead of sub-cycle.`
        );
        this.frameEventBuffer.push({ ...event, sync: false });
        return;
      }
    }
    
    // Log warning at threshold
    if (startDepth >= this.subCycleConfig.warningDepth) {
      console.warn(
        `[Space] Sub-cycle depth ${startDepth} - consider if this is intentional. ` +
        `Event: ${event.topic} from ${event.source.componentId}`
      );
    }
    
    // Track sub-cycle start
    this.currentSubCycleDepth = startDepth;
    const startDeltaIndex = this.currentFrame?.deltas.length || 0;
    const startTime = performance.now();
    const eventId = `${event.topic}-${event.timestamp}`;
    
    console.log(`[Space] Starting sub-cycle at depth ${startDepth} for event: ${event.topic}`);
    
    try {
      // Process the event through subscribed components
      this.executeEventThroughComponents(event);
    } finally {
      // Record sub-cycle trace
      if (this.currentFrame) {
        this.currentSubCycleTrace.push({
          depth: startDepth,
          triggeringEventId: eventId,
          emittingComponentId: event.source.componentId,
          deltasRange: [startDeltaIndex, this.currentFrame.deltas.length],
          durationMs: performance.now() - startTime
        });
      }
      
      // Restore depth
      this.currentSubCycleDepth = startDepth - 1;
      
      console.log(`[Space] Completed sub-cycle at depth ${startDepth}, produced ${(this.currentFrame?.deltas.length || 0) - startDeltaIndex} deltas`);
    }
  }
  
  /**
   * Execute an event through all subscribed components
   * Used for both main cycle and sub-cycles
   */
  private executeEventThroughComponents(event: SpaceEvent): void {
    if (!this.currentFrame) return;
    
    // Determine which components to iterate
    const startIndex = this.subCycleConfig.fullCycle ? 0 : this.currentComponentIndex + 1;
    
    // Build execution context
    const context = {
      event,
      state: this.getReadonlyState(),
      sequence: this.currentFrame.sequence,
      timestamp: this.currentFrame.timestamp,
      frame: this.currentFrame as import('../veil/types').ReadonlyFrame,
      bufferedEvents: this.frameEventBuffer
    };
    
    for (let i = startIndex; i < this.components.length; i++) {
      const component = this.components[i];
      if (!component.enabled) continue;
      
      // Check topic subscription
      if (!component.matchesTopic(event.topic)) continue;
      
      // Check optional event filter
      if (component.eventFilter && !component.eventFilter(event)) continue;
      
      try {
        // Execute synchronously for sub-cycles (no await)
        component.execute(context);
        
        // Update context state after each component
        context.state = this.getReadonlyState();
        
        // Also deliver to handleEvent for legacy compatibility
        if (component.isSubscribedTo(event.topic)) {
          component.handleEvent(event);
        }
      } catch (err) {
        console.error(`[Space] Error in sub-cycle execution of ${component.constructor.name}:`, err);
      }
    }
  }

  /**
   * Subscribe to event topics
   */
  subscribe(topicPattern: string): void {
    this._subscriptions.push(topicPattern);
  }

  /**
   * Get a reference to this Space
   */
  getRef(): ComponentRef {
    return {
      componentId: this.id,
      componentPath: ['root'],
      componentType: 'Space'
    };
  }
  
  /**
   * Schedule a callback to run at the start of the next frame
   */
  runNextFrame(callback: () => void): void {
    this.nextFrameCallbacks.push(callback);
    this.requestFrame();
  }

  /**
   * Process one frame
   */
  private async processFrame(): Promise<void> {
    if (this.processingFrame) return;
    
    // Run next frame callbacks first
    const callbacks = [...this.nextFrameCallbacks];
    this.nextFrameCallbacks = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch (err) {
        console.error('[Space] Error in next frame callback:', err);
      }
    }
    
    // Skip frame processing during restoration
    if (this.isRestoring) {
      console.log('[Space] Skipping frame processing during restoration');
      return;
    }
    this.processingFrame = true;
    
    const frameId = this.veilState.getNextSequence();
    const frameStartClock = performance.now();
    const frameSpan = this.tracer?.startSpan('processFrame', 'Space');
    const timestamp = new Date().toISOString();

    try {
      // Create frame structure
      const frame: Frame = {
        sequence: frameId,
        timestamp,
        uuid: deterministicUUID(`frame-${frameId}`),
        events: [],
        deltas: [],
        transition: createDefaultTransition(frameId, timestamp)
      };
      
      this.currentFrame = frame;
      
      this.notifyDebugFrameStart(this.currentFrame, {
        queuedEvents: this.eventQueue.length,
        components: this.getComponentSnapshots()
      });
      
      // Drain event queue - Take ONE event
      const event = this.eventQueue.shift();
      
      if (!event) {
        // Should not happen if loop check is correct, but safety first
        this.processingFrame = false;
        return;
      }
      
      // Record processed event in frame
      frame.events = [event];
      
      // Emit frame:start (this is a system event, handled specially?)
      // Or just process components.
      // In Phase 3, we iterate components for THIS event.
      // Prepare execution context for component execution
      const context = {
        event,
        state: this.getReadonlyState(),
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        frame: frame as import('../veil/types').ReadonlyFrame,
        bufferedEvents: this.frameEventBuffer
      };

      // Reset sub-cycle tracking for this frame
      this.currentSubCycleDepth = 0;
      this.currentSubCycleTrace = [];

      // Sequential Execution
      // Index-based iteration allows components to be added during execution
      // Components can insert after current position using addComponent options

      const componentExecutions: import('../debug/types').ComponentExecutionRecord[] = [];
      const trackingEnabled = this.enableComponentTracing;

      for (let i = 0; i < this.components.length; i++) {
        const component = this.components[i];
        this.currentComponentIndex = i;  // Track for partial cycle sub-cycles
        if (!component.enabled) continue;
        
        // Check topic subscription before executing
        if (!component.matchesTopic(event.topic)) continue;
        
        // Check optional event filter
        if (component.eventFilter && !component.eventFilter(event)) continue;

        let startDeltaCount = 0;
        let startEventBufferCount = 0;
        let startTime = 0;
        let error: string | undefined;
        let contextSnapshot: any;
        let emittedEventDetails: any[] | undefined;

        if (trackingEnabled) {
           startDeltaCount = frame.deltas.length;
           startEventBufferCount = this.frameEventBuffer.length;
           startTime = performance.now();

           // Capture input context for detailed inspection
           contextSnapshot = {
             inputEvent: {
               topic: context.event.topic,
               source: context.event.source,
               payload: context.event.payload
             },
             stateSnapshot: {
               facetCount: context.state.facets.size,
               sequence: context.state.currentSequence
             },
             eventBufferSnapshot: this.frameEventBuffer.map(evt => ({
               topic: evt.topic,
               source: evt.source,
               payload: evt.payload
             }))
           };
        }

        try {
          // Execute component logic (await to capture async emissions)
          await component.execute(context);

          // Update context.state after each component so subsequent components
          // see the latest state including deltas applied by earlier components
          context.state = this.getReadonlyState();

          // Also deliver event to handleEvent (legacy/direct subscription)
          // This maintains compatibility with components using handleEvent
          // but not yet migrated to execute() logic (if any)
          // OR if execute() is the new way, maybe handleEvent is called internally?
          // Component.execute is no-op by default.
          // If we want legacy handleEvent to work, we should call it.
          if (component.isSubscribedTo(event.topic)) {
             await component.handleEvent(event);
          }

        } catch (err: any) {
          console.error(`[Space] Error executing component ${component.constructor.name}:`, err);
          error = err.message || String(err);
        } finally {
           if (trackingEnabled) {
              // Capture events emitted by this component
              const newEventCount = this.frameEventBuffer.length - startEventBufferCount;
              if (newEventCount > 0) {
                emittedEventDetails = this.frameEventBuffer.slice(startEventBufferCount).map(evt => ({
                  topic: evt.topic,
                  source: evt.source,
                  payload: evt.payload
                }));
              }

              componentExecutions.push({
                componentId: component.id || 'unknown',
                componentName: component.constructor.name,
                durationMs: performance.now() - startTime,
                deltaStartIndex: startDeltaCount,
                deltaEndIndex: frame.deltas.length,
                emittedEvents: newEventCount,
                error,
                context: contextSnapshot,
                emittedEventDetails
              });
           }
        }
      }
      
      // Flush buffer to event queue
      // Push directly to eventQueue instead of calling queueEvent() to avoid
      // re-buffering while processingFrame is still true
      if (this.frameEventBuffer.length > 0) {
        for (const bufferedEvent of this.frameEventBuffer) {
          this.eventQueue.push(bufferedEvent);
        }
        this.frameEventBuffer = [];
      }
      
      // Add sub-cycle trace to frame if any sub-cycles occurred
      if (this.currentSubCycleTrace.length > 0) {
        frame.subCycleTrace = [...this.currentSubCycleTrace];
      }
      
      // Finalize frame
      this.veilState.finalizeFrame(frame, true);
      
      // Clean up ephemeral facets
      const ephemeralCleanup = this.veilState.cleanupEphemeralFacets();
      // cleanupEphemeralFacets returns changes that WERE applied (FacetDelta[])
      // Note: Ephemeral cleanup returns FacetDelta[], not VEILDelta[]
      // Frame.deltas contains VEILDelta (VEIL operations), not outcome deltas
      // Ephemeral cleanup is tracked implicitly by the state manager, not recorded in frame
      
      // Notify debug observers
        this.notifyDebugFrameComplete(this.currentFrame, {
          durationMs: performance.now() - frameStartClock,
          processedEvents: 1, // We processed one event
          componentExecutions: trackingEnabled ? componentExecutions : undefined
        });
        
    } finally {
      this.currentFrame = undefined;
      
      if (frameSpan) {
        this.tracer?.endSpan(frameSpan.id);
      }
      
      const hasMore = this.eventQueue.length > 0;
      this.processingFrame = false;

      if (hasMore && !this.frameScheduled) {
        this.frameScheduled = true;
        setImmediate(() => {
          this.frameScheduled = false;
          this.processFrame();
        });
      }
    }
  }
  
  private async deliverEventToComponents(event: SpaceEvent): Promise<void> {
    // No-op in new architecture - handled in processFrame loop
  }
  
  // Removed Phase methods (runPhase0, runPhase1, etc.)
  
  /**
   * Apply component-state delta with scoped write validation
   */
  _applyComponentStateDelta(delta: VEILDelta, componentId: string): void {
    if (delta.type !== 'rewriteFacet' || !delta.id.startsWith('component-state:')) {
      throw new Error(`_applyComponentStateDelta can only be used for component-state facets`);
    }
    
    const expectedId = `component-state:${componentId}`;
    if (delta.id !== expectedId) {
      throw new Error(`Component ${componentId} attempted to modify ${delta.id}. Components can only modify their own state.`);
    }
    
    this.veilState.applyDeltasDirect([delta]);
    if (this.currentFrame) {
      this.currentFrame.deltas.push(delta);
    }
  }

  /**
   * Helper to check if facet matches effector filters
   */
  private matchesEffectorFilters(facet: Facet, filters: FacetFilter[]): boolean {
    if (filters.length === 0) return true;
    
    return filters.some(filter => {
      if (filter.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        if (!types.includes(facet.type)) return false;
      }
      
      if (filter.aspectMatch) {
        for (const [aspect, value] of Object.entries(filter.aspectMatch)) {
          if ((facet as any)[aspect] !== value) return false;
        }
      }
      
      if (filter.attributeMatch) {
        if (!facet.attributes) return false;
        for (const [key, value] of Object.entries(filter.attributeMatch)) {
          if (facet.attributes[key] !== value) return false;
        }
      }
      
      return true;
    });
  }
  
  /**
   * Get read-only view of state
   */
  private getReadonlyState(): ReadonlyVEILState {
    const state = this.veilState.getState();
    
    return {
      facets: state.facets as ReadonlyMap<string, Facet>,
      scopes: state.scopes as ReadonlySet<string>,
      streams: state.streams as ReadonlyMap<string, any>,
      agents: state.agents as ReadonlyMap<string, AgentInfo>,
      currentStream: state.currentStream,
      currentAgent: state.currentAgent,
      frameHistory: [...state.frameHistory],
      currentSequence: state.currentSequence,
      removals: new Map(state.removals),
      
      getFacetsByType: (type: string) => {
        return Array.from(state.facets.values()).filter(f => f.type === type);
      },
      
      getFacetsByAspect: (aspect: keyof Facet, value: any) => {
        return Array.from(state.facets.values()).filter(f => (f as any)[aspect] === value);
      },
      
      hasFacet: (id: string) => {
        return state.facets.has(id);
      }
    };
  }
  
  /**
   * Get the VEIL state manager
   */
  getVEILState(): VEILStateManager {
    return this.veilState;
  }
  
  /**
   * Register a reference for dependency injection
   */
  registerReference(id: string, value: any): void {
    this.hostRegistry.set(id, value);
  }
  
  /**
   * Get a reference by ID
   */
  getReference(id: string): any {
    return this.hostRegistry.get(id);
  }
  
  /**
   * List all available references (for debugging)
   */
  listReferences(): string[] {
    return Array.from(this.hostRegistry.keys());
  }

  private getComponentSnapshots(): import('../debug/types').DebugComponentSnapshot[] {
    return this.components.map(c => ({
      id: c.id || 'unknown',
      name: c.constructor.name,
      constraints: c.getConstraintFacets(),
      enabled: c.enabled
    }));
  }

  private notifyDebugFrameStart(frame: Frame, context: DebugFrameStartContext): void {
    for (const observer of this.debugObservers) {
      observer.onFrameStart?.(frame, context);
    }
  }

  private notifyDebugFrameComplete(frame: Frame, context: DebugFrameCompleteContext): void {
    for (const observer of this.debugObservers) {
      observer.onFrameComplete?.(frame, context);
    }
  }
  
  /**
   * Activate the agent with specified stream configuration
   */
  activateAgent(
    streamId: string, 
    options: {
      source?: string;
      reason?: string;
      priority?: 'low' | 'normal' | 'high';
      streamType?: string;
      metadata?: Record<string, any>;
    } = {}
  ): void {
    this.emit({
      topic: 'agent:activate',
      source: this.getRef(),
      payload: {
        streamId,
        ...options
      },
      timestamp: Date.now()
    });
  }
}
