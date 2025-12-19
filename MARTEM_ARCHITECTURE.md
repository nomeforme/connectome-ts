# MARTEM Architecture Design

**⚠️ DEPRECATED**: This document describes the legacy MARTEM phase-based architecture which has been replaced by **FLEX** (Flat List Execution). This is kept for historical reference only.

**Current Architecture**: See `FLEX_ARCHITECTURE.md` for the active system design.

**Status**: The MARTEM phase system (`runPhase0`, `runPhase1`, etc.) has been removed. Component base classes (`BaseReceptor`, `BaseTransform`, etc.) remain as a compatibility shim that provides default priorities for FLEX execution.

---

## Overview (Historical)

The MARTEM architecture unified all processing components under a single Component interface, managed by the element tree. This replaced the split between "legacy components" and "RETM types".

## Component Hierarchy

```typescript
// Base Component interface - minimal lifecycle
interface Component {
  // Lifecycle
  mount(element: Element): Promise<void>;
  unmount(): Promise<void>;
  destroy?(): Promise<void>;  // Optional cleanup beyond unmount
}

// MARTEM components extend the base
interface Modulator extends Component {
  process(events: SpaceEvent[]): SpaceEvent[];
  reset?(): void;
}

interface Afferent<TConfig = any, TCommand = any> extends Component {
  // Lifecycle
  initialize(context: AfferentContext<TConfig>): Promise<void>;
  start(): Promise<void>;
  stop(graceful?: boolean): Promise<void>;
  
  // Commands from effectors
  enqueueCommand(command: TCommand): void;
  
  // Status
  getStatus(): AfferentStatus;
  getMetrics(): AfferentMetrics;
}

interface Receptor extends Component {
  topics: string[];
  transform(event: SpaceEvent, state: ReadonlyVEILState): Facet[];
}

interface Transform extends Component {
  facetFilters?: FacetFilter[];
  process(state: ReadonlyVEILState): VEILDelta[];
}

interface Effector extends Component {
  facetFilters?: FacetFilter[];
  process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult>;
}

interface Maintainer extends Component {
  process(frame: Frame, changes: FacetDelta[], state: ReadonlyVEILState): Promise<SpaceEvent[]>;
}
```

## Processing Flow

```
External World
     ↓
[Afferents] → Events
     ↓
Event Queue
     ↓
[Modulators] → Filtered/Aggregated Events (Phase 0)
     ↓
[Receptors] → Facets (Phase 1)
     ↓
[Transforms] → More Facets (Phase 2, iterative)
     ↓
[Effectors] → Events + External Actions (Phase 3)
     ↓
[Maintainers] → Persistence/Cleanup (Phase 4)
```

## Component Creation

All components are created through element-request facets:

```typescript
// Component creation facet
interface ComponentRequestFacet extends Facet {
  type: 'component-request';
  state: {
    componentType: string;     // 'discord-afferent', 'rate-limit-modulator', etc.
    componentClass: 'modulator' | 'afferent' | 'receptor' | 'transform' | 'effector' | 'maintainer';
    elementId: string;         // Parent element
    config?: any;             // Component-specific config
  };
}
```

## ElementTreeMaintainer Updates

```typescript
class ElementTreeMaintainer implements Maintainer {
  async process(frame: Frame, changes: FacetDelta[], state: ReadonlyVEILState): Promise<SpaceEvent[]> {
    // Process component requests
    for (const facet of state.facets.values()) {
      if (facet.type === 'component-request' && facet.state.elementId) {
        const element = this.findElement(facet.state.elementId);
        if (!element) continue;
        
        const component = await this.createComponent(facet.state);
        await component.mount(element);
        
        // Register with Space based on type
        switch (facet.state.componentClass) {
          case 'modulator':
            this.space.addModulator(component as Modulator);
            break;
          case 'afferent':
            // Afferents are self-managing after mount
            break;
          case 'receptor':
            this.space.addReceptor(component as Receptor);
            break;
          case 'transform':
            this.space.addTransform(component as Transform);
            break;
          case 'effector':
            this.space.addEffector(component as Effector);
            break;
          case 'maintainer':
            this.space.addMaintainer(component as Maintainer);
            break;
        }
      }
    }
  }
}
```

## Example Components

### Modulator: Event Deduplication
```typescript
class DeduplicationModulator implements Modulator {
  private recentEvents = new Map<string, number>();
  private windowMs = 1000;
  
  async mount(element: Element): Promise<void> {
    // Start cleanup timer
    setInterval(() => this.cleanOldEvents(), this.windowMs);
  }
  
  process(events: SpaceEvent[]): SpaceEvent[] {
    const now = Date.now();
    return events.filter(event => {
      const key = `${event.topic}:${JSON.stringify(event.payload)}`;
      const lastSeen = this.recentEvents.get(key);
      
      if (!lastSeen || now - lastSeen > this.windowMs) {
        this.recentEvents.set(key, now);
        return true;
      }
      return false;
    });
  }
  
  private cleanOldEvents() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, time] of this.recentEvents) {
      if (time < cutoff) {
        this.recentEvents.delete(key);
      }
    }
  }
}
```

### Afferent: WebSocket Listener
```typescript
class WebSocketAfferent extends BaseAfferent<WebSocketConfig, WebSocketCommand> {
  private ws?: WebSocket;
  
  protected async onStart(): Promise<void> {
    this.ws = new WebSocket(this.context.config.url);
    
    this.ws.on('message', (data) => {
      this.emit({
        topic: 'websocket:message',
        source: { elementId: this.id, elementPath: [] },
        timestamp: Date.now(),
        payload: { data }
      });
    });
    
    this.ws.on('error', (error) => {
      this.handleError('connection', 'WebSocket error', error);
    });
  }
  
  protected async onCommand(command: WebSocketCommand): Promise<void> {
    switch (command.type) {
      case 'send':
        this.ws?.send(command.data);
        break;
    }
  }
}
```

## Benefits

1. **Unified Lifecycle**: All components share the same lifecycle management
2. **Hot Reload**: Works uniformly for all component types
3. **Element Tree Integration**: Single source of truth for active components
4. **Clean Separation**: Each component type has a clear responsibility
5. **Extensibility**: Easy to add new modulators, afferents, etc.
6. **Sandboxing**: Element unmount automatically cleans up all child components

## Migration Path

1. Update Component interface to be the minimal base
2. Make RETM interfaces extend Component
3. Update ElementTreeMaintainer to handle all component types
4. Convert existing "legacy" components to appropriate MARTEM types
5. Add Space methods for modulators and afferents

## Summary

MARTEM creates a clean, unified architecture where:
- **M**odulators preprocess events
- **A**fferents bridge external systems
- **R**eceptors convert events to facets
- **T**ransforms process facets
- **E**ffectors react and act
- **M**aintainers handle persistence

All managed through the element tree, all following the same lifecycle patterns.
