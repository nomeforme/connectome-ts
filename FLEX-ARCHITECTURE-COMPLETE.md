# FLEX Architecture Documentation

**Branch:** `flex-refactor`
**Status:** Phase 4 Complete (Constraint-based Priority)
**Architecture Status:** Active (Replaces MARTEM)
**Date:** November 2025

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Core Contract: The Component](#core-contract-the-component)
3. [Execution Model](#execution-model)
4. [Constraint: Priority](#constraint-priority)
5. [Frame Processing Lifecycle](#frame-processing-lifecycle)
6. [Migration from MARTEM](#migration-from-martem)
7. [Practical Implementation](#practical-implementation)
8. [Debugging and Inspection](#debugging-and-inspection)
9. [Performance Characteristics](#performance-characteristics)
10. [Known Issues and Future Work](#known-issues-and-future-work)
11. [Quick Reference](#quick-reference)

---

## Executive Summary

FLEX (Flat List Execution) is Connectome's simplified event processing architecture that replaces the complex MARTEM phase-based system. It eliminates the Element tree hierarchy and phase boundaries in favor of a single, priority-ordered flat list of components that execute sequentially.

### Key Benefits

- **Simplicity**: One flat list, one execution order—no tree traversal, no phase boundaries
- **Visibility**: Components see changes made by earlier components in the same frame
- **Debuggability**: Linear execution trace makes debugging straightforward
- **Alignment**: Mirrors natural LLM interaction patterns (sequential processing)
- **Performance**: Eliminates tree traversal overhead and complex subscription filtering

### Architecture at a Glance

```typescript
// MARTEM (Old): Complex tree + phase-based batching
space (Element)
  └─ agent-element (Element)
      ├─ MessageReceptor (Component, Phase 1)
      ├─ ContextTransform (Component, Phase 2)
      └─ ResponseEffector (Component, Phase 3)

// FLEX (New): Simple flat constraint-ordered list
space.components = [
  MessageReceptor (constraint: priority 100),
  ContextTransform (constraint: priority 200),
  ResponseEffector (constraint: priority 300)
]
```

---

## Core Contract: The Component

The fundamental unit of FLEX is the `Component`—a transformer that consumes the current world state and produces changes.

### The Interface

```typescript
import { ConstraintFacet, priorityConstraint } from './constraints';

abstract class Component {
  /**
   * Constraints determine execution order and behavior.
   * The priority constraint controls execution order (lower = earlier).
   */
  constraints: ConstraintFacet[] = [];

  /**
   * The main pulse of logic, called once per frame per component.
   * Consumes context to produce side effects (VEIL operations).
   */
  execute(context: ExecutionContext): void;

  /**
   * Lifecycle hook called when component is added to space.
   */
  onMount(): void;

  /**
   * Direct reference to the containing space (no tree traversal).
   */
  space: Space;
}
```

**Priority as a Constraint**: Priority is just one type of constraint. Components declare their priority via the `constraints` array:

```typescript
class MyComponent extends Component {
  constraints = [priorityConstraint(100)];  // Receptor-level priority
}
```

### Inputs: ExecutionContext

Every component receives a context object representing the exact moment of execution:

```typescript
interface ExecutionContext {
  // Inputs (Immutable)
  readonly event: SpaceEvent;         // The trigger (e.g., "user.message")
  readonly state: ReadonlyVEILState;  // LIVE world model (includes earlier changes)

  // Metadata (Immutable)
  readonly sequence: number;          // Frame sequence ID
  readonly timestamp: string;         // Frame timestamp
  readonly frame: ReadonlyFrame;      // Read-only view of current frame

  // Control Surface (Mutable)
  /**
   * Buffer of OUTGOING events emitted during this frame.
   * Components can inspect, modify, or cancel events emitted by earlier components
   * before they are flushed to the main queue.
   */
  bufferedEvents: SpaceEvent[];
}
```

**Critical Feature 1**: The `state` is refreshed after every component execution. If Component A (priority 100) creates a facet, Component B (priority 200) sees it immediately in the same frame.

**Critical Feature 2**: The `bufferedEvents` array is mutable. High-priority components (e.g., filters or modulators running late in the chain) can inspect and remove events emitted by earlier components, effectively canceling their future consequences.

**Critical Feature 3**: The `frame` provides readonly access to the current frame being processed. Components can inspect `frame.deltas` to see what operations were queued this frame, but cannot mutate the frame. This is primarily for backward compatibility with MARTEM-style effectors that need to detect specific facet additions.

### Outputs: Side Effects

Components change the world through these methods:

1. **State Operations** (Primary): `this.addOperation(delta)`
   - Immediately modifies VEIL state
   - Visible to all subsequent components in the same frame

2. **New Events**: `this.emit(event)`
   - Queues an event for a future frame
   - Never processed in current frame (prevents recursion)

3. **External Actions**: Direct API calls
   - Reserved for Effectors (priority 300)
   - Database writes, HTTP requests, Discord messages, etc.

---

## Execution Model

### Sequential Processing

FLEX processes one event per frame through a single, linear execution pipeline:

```typescript
// Simplified frame processing
async processFrame() {
  const event = eventQueue.shift();        // One event per frame
  
  // Prepare context with mutable event buffer
  const context = { 
    event, 
    state: this.getReadonlyState(),
    sequence: frame.sequence,
    timestamp: frame.timestamp,
    bufferedEvents: this.frameEventBuffer
  };

  // Sequential execution through priority-ordered components
  for (const component of this.components) {
    if (!component.enabled) continue;

    // Execute component
    component.execute(context);

    // Critical: Update state for next component
    context.state = this.getReadonlyState();
  }

  // Cleanup and prepare for next frame
  finalizeFrame();
  cleanupEphemeralFacets();
  flushBufferedEvents(); // Pushes bufferedEvents to main queue
}
```

### State Visibility Comparison

The key difference between MARTEM and FLEX:

```typescript
// MARTEM: State frozen per phase
runPhase1(state₀);  // All Receptors see state₀
runPhase2(state₁);  // All Transforms see state₁

// FLEX: State updated after each component
receptorA.execute(state₀);   // Creates activation facet
state₁ = getReadonlyState();
receptorB.execute(state₁);   // Sees activation ✓
state₂ = getReadonlyState();
transformA.execute(state₂);  // Sees all Receptor changes ✓
```

This enables same-frame reactivity—components can respond to changes made by earlier components without waiting for the next frame.

---

## Constraint: Priority

Priority is a **type of constraint** in the FLEX architecture. Components declare constraints via a `constraints` array, and the priority constraint determines execution order.

### The Priority Constraint

```typescript
import { priorityConstraint, ComponentPriority } from './constraints';

// Using named constants
class MyReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];  // 100
}

// Using numeric values directly
class CustomComponent extends Component {
  constraints = [priorityConstraint(150)];  // Between receptor and transform
}

// ComponentPriority constants:
// MODULATOR: 0, RECEPTOR: 100, TRANSFORM: 200, EFFECTOR: 300, MAINTAINER: 400
```

### Standard Priority Ranges

Components are organized into logical groups by priority constraint:

| Priority | Role | Purpose | Example Components |
|----------|------|---------|-------------------|
| **0-99** | **Modulators** | Event preprocessing | EventFilter, EventAggregator, RateLimiter |
| **100-199** | **Receptors** | Event → VEIL facets | MessageReceptor, CommandReceptor |
| **200-299** | **Transforms** | VEIL processing | ContextTransform, StateReducer |
| **300-399** | **Effectors** | Side effects | ResponseEffector, DatabaseWriter |
| **400-499** | **Maintainers** | Cleanup & persistence | StatePersister, MetricsCollector |

### Priority Constraint Rules

1. **Lower executes first**: Priority 0 runs before priority 100
2. **Same priority = undefined order**: Don't rely on execution order within same priority
3. **Fractional priorities allowed**: Use 100.5, 100.75 for fine control
4. **Custom priorities encouraged**: Set any priority that makes sense for your logic
5. **No priority = 0**: Components without a priority constraint default to priority 0

### Example: Custom Priority Constraints

```typescript
class ActivationReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];  // 100

  execute(context: ExecutionContext): void {
    if (context.event.topic === 'agent.activate') {
      this.addOperation({
        type: 'addFacet',
        facet: { type: 'activation', agentId: context.event.payload.agentId }
      });
    }
  }
}

class ActivationDependentTransform extends Component {
  constraints = [priorityConstraint(150)];  // Between receptor and transform

  execute(context: ExecutionContext): void {
    const activation = context.state.facets.get('activation');
    if (activation) {
      // Process with activation present
    }
  }
}
```

---

## Frame Processing Lifecycle

Each frame follows this precise sequence:

### 1. Frame Initialization
```typescript
const event = eventQueue.shift();
const frame = {
  sequence: getNextSequence(),
  timestamp: new Date().toISOString(),
  uuid: generateUUID(),
  events: [event],
  deltas: [],
  transition: createDefaultTransition()
};

// Frame is passed to components as ReadonlyFrame in ExecutionContext
// Components can inspect frame.deltas but cannot mutate the frame
```

### 2. Component Execution Loop
```typescript
for (const component of sortedComponents) {
  // Execute component
  component.execute(context);

  // Apply any VEIL operations immediately
  processBufferedOperations();

  // Update context for next component
  context.state = getReadonlyState();

  // Legacy support: call handleEvent if exists
  if (component.handleEvent && component.isSubscribedTo(event.topic)) {
    await component.handleEvent(event);
  }
}
```

### 3. Frame Finalization
```typescript
// Record frame in history
frameHistory.push(frame);

// Clean up ephemeral facets (single-frame lifetime)
veilState.cleanupEphemeralFacets();

// Add buffered events to queue for next frame
eventQueue.push(...bufferedEvents);
bufferedEvents.clear();
```

### Important Timing Considerations

- **Events emitted in frame N** are processed in frame N+1 or later
- **Ephemeral facets** exist for entire frame, cleaned at frame end
- **State changes** are visible immediately to subsequent components
- **External side effects** should only occur in Effectors (priority 300+)

---

## Migration from MARTEM

### Backward Compatibility

FLEX maintains compatibility through base classes that act as shims:

```typescript
// Legacy MARTEM-style component
class MyReceptor extends BaseReceptor {
  topics = ['user.message'];

  transform(event: SpaceEvent, state: VEILState): VEILDelta[] {
    return [{
      type: 'addFacet',
      facet: { type: 'message', content: event.payload.text }
    }];
  }
}

// Still works! BaseReceptor provides:
// - constraints = [priorityConstraint(100)] (default for receptors)
// - execute() that calls transform()
// - Subscription checking (though less efficient)
```

**Note**: The legacy base classes are deprecated. Prefer using `Component` directly with explicit constraints.

### Migration Path

#### For New Components

Use the modern Component API directly:

```typescript
import { priorityConstraint, ComponentPriority } from './constraints';

class ModernComponent extends Component {
  constraints = [priorityConstraint(ComponentPriority.TRANSFORM)];  // 200

  execute(context: ExecutionContext): void {
    // Direct access to context
    const { event, state, frame } = context;

    // Process based on event topic
    if (event.topic === 'my.event') {
      // Create VEIL operations
      this.addOperation({
        type: 'addFacet',
        facet: { type: 'processed', data: event.payload }
      });

      // Emit new events for future frames
      this.emit({ topic: 'processing.complete' });
    }

    // Optional: Inspect frame.deltas to detect specific operations
    // frame is ReadonlyFrame - you can read but not mutate
    // const hasActivation = frame.deltas.some(d =>
    //   d.type === 'addFacet' && d.facet.type === 'agent-activation'
    // );
  }

  onMount(): void {
    console.log('Component mounted to space:', this.space.id);
  }
}

// Register component
space.addComponent(new ModernComponent());
```

#### For Legacy Components

1. **Keep using base classes** (with deprecation warnings):
   ```typescript
   class LegacyReceptor extends BaseReceptor {
     // Works but shows: [Deprecation] Convert to Component
   }
   ```

2. **Gradual migration** when touching code:
   - Replace `extends BaseReceptor` with `extends Component`
   - Add `constraints = [priorityConstraint(100)]` explicitly
   - Move `transform()` logic into `execute()`
   - Remove `topics` array, filter in `execute()` instead

### Breaking Changes

These patterns no longer work:

```typescript
// ❌ Tree navigation
const space = this.element.findSpace();
const child = this.element.findChild('child-id');
this.element.parent;

// ✅ Direct access
const space = this.space;
// No child lookup - components are flat
// No parent - no tree hierarchy

// ❌ Subscription filtering
this.subscribe('my-topic');  // No-op, doesn't filter

// ✅ Manual filtering
execute(context) {
  if (context.event.topic !== 'my-topic') return;
  // Process event
}
```

### Deprecation Warnings

The base MARTEM classes (`BaseReceptor`, `BaseTransform`, etc.) emit deprecation warnings to encourage migration:
```
[Deprecation] MyReceptor is a Receptor. Convert to Component.
```

Note: These warnings are currently always shown and cannot be disabled via environment variable.

---

## Practical Implementation

### Component Registration

```typescript
// Create space
const space = new Space();

// Add components directly (no tree structure)
space.addComponent(new MessageReceptor());      // constraint: priority 100
space.addComponent(new ContextTransform());     // constraint: priority 200
space.addComponent(new ResponseEffector());     // constraint: priority 300

// Components automatically sorted by priority constraint
// Priority is extracted from constraints, not a first-class field
```

### Handling Dependencies

When Component B depends on Component A's output:

```typescript
class ComponentA extends Component {
  constraints = [priorityConstraint(100)];  // Runs first

  execute(context) {
    this.addOperation({
      type: 'addFacet',
      facet: { type: 'activation', id: 'a1' }
    });
  }
}

class ComponentB extends Component {
  constraints = [priorityConstraint(200)];  // Runs after A, sees activation

  execute(context) {
    const activation = context.state.facets.get('activation');
    if (activation) {
      // Process with activation available
    }
  }
}
```

### Event Patterns

```typescript
class EventProcessor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];

  execute(context: ExecutionContext): void {
    // Pattern 1: Process current event
    if (context.event.topic === 'input.received') {
      this.processInput(context.event.payload);
    }

    // Pattern 2: Emit follow-up event (processed next frame)
    this.emit({
      topic: 'input.processed',
      payload: { processedAt: Date.now() }
    });

    // Pattern 3: Conditional event emission
    if (shouldTriggerAlert(context.state)) {
      this.emit({ topic: 'alert.trigger' });
    }
  }

  private processInput(payload: any): void {
    // Create facet for this frame
    this.addOperation({
      type: 'addFacet',
      facet: {
        type: 'input',
        ephemeral: true,  // Cleaned at frame end
        data: payload
      }
    });
  }
}
```

---

## Debugging and Inspection

### Runtime Component Inspection

```typescript
import { PriorityConstraintFacet } from './constraints';

// Helper to extract priority from constraints
function getComponentPriority(c: Component): number {
  const priorityFacet = c.getConstraintFacets()
    .find(f => f.type === 'priority') as PriorityConstraintFacet | undefined;
  return priorityFacet?.priority ?? 0;
}

// View all components and their priority constraints
space.components.forEach(c => {
  console.log(`${c.constructor.name}: constraint priority ${getComponentPriority(c)}`);
});

// Check execution order (already sorted by Space)
console.log('Execution order:', space.components.map(c => c.constructor.name));
```

### Debug Registry (Node Inspector)

When launched with `--inspect`:

```bash
node --inspect=9229 -r ts-node/register your-app.ts
```

Access via debugger console:
```javascript
// Global debug registry
const debug = global.__connectome_debug;

// Inspect components (uses helper methods added by debug registry)
debug.getComponents();  // Returns [{id, name, priority, enabled, type}]
debug.getComponentsByPriority();  // Returns Map<number, ComponentInfo[]>

// Watch state changes
debug.veilState.getState().facets;

// Inject test events
await debug.space.emit({ topic: 'test', payload: {} });
```

### Debug MCP Tools

```typescript
// Connect to debug server
mcp__connectome-session__connect({ port: 3015 });

// Get component list with priorities
const state = await mcp__connectome-session__getState();
console.log(state.space.components);

// View execution frames
const frames = await mcp__connectome-session__getFrames({ limit: 10 });

// Search for specific patterns
const results = await mcp__connectome-session__searchFrames({
  pattern: 'activation',
  limit: 20
});
```

### Tracing Execution

Enable trace logging to files:
```bash
ENABLE_TRACING=true npm start
```

When enabled, the tracing system:
- Writes JSON trace events to `./traces` directory
- Outputs colored console logs with component prefixes
- Tracks LLM requests, responses, and system lifecycle events

Console output format:
```
[Space:queueEvent] Event queued: user.message
[Space.addComponent] Registered MessageReceptor (msg-receptor-1)
[Space.applyOperation] Applying addFacet delta immediately
[BasicAgent:processAgent] Agent basic-agent-1 processing
[MockLLMProvider:complete] Generating mock response
```

Trace files contain detailed JSON events:
```json
{
  "id": "evt-1234567890",
  "timestamp": 1732123456789,
  "level": "info",
  "category": "agent",
  "component": "BasicAgent",
  "operation": "processAgent",
  "data": { "agentId": "basic-agent-1", "messageCount": 3 }
}
```

View traces in `./traces/trace-YYYY-MM-DD.json` files.

---

## Performance Characteristics

### Improvements over MARTEM

| Aspect | MARTEM | FLEX | Improvement |
|--------|--------|------|-------------|
| Tree traversal | O(n) depth-first | O(1) direct access | ~10x faster |
| Event delivery | Tree propagation | Direct iteration | ~5x faster |
| State access | Phase snapshots | Live reference | No copying |
| Memory usage | Parent/child pointers | Flat array | ~30% less |
| Subscription filtering | Complex matching | Simple if-check | ~3x faster |

### Performance Considerations

#### State Refresh Overhead

- Each component execution triggers state refresh
- Cost scales with number of components × facets
- Mitigation: Group related logic in single component

#### Event Buffering Latency

- Events emitted during frame wait until next frame
- Adds 1 frame delay (typically 10-50ms)
- Mitigation: Use direct method calls for synchronous needs

### Optimization Strategies

1. **Minimize Component Count**
   ```typescript
   // ❌ Many small components
   class ReceptorA extends Component { constraints = [priorityConstraint(100)]; }
   class ReceptorB extends Component { constraints = [priorityConstraint(101)]; }
   class ReceptorC extends Component { constraints = [priorityConstraint(102)]; }

   // ✅ One grouped component
   class CombinedReceptor extends Component {
     constraints = [priorityConstraint(100)];
     execute(context) {
       this.processA(context);
       this.processB(context);
       this.processC(context);
     }
   }
   ```

2. **Use Component Enabling**
   ```typescript
   // Disable expensive components when not needed
   component.enabled = false;  // Skipped during execution

   // Re-enable when needed
   component.enabled = true;
   ```

3. **Priority Constraint Optimization**
   ```typescript
   // Put filters/guards early (low priority constraint)
   class EventFilter extends Component {
     constraints = [priorityConstraint(ComponentPriority.MODULATOR)];  // 0 - Run first
   }

   // Put expensive operations late
   class ExpensiveAnalysis extends Component {
     constraints = [priorityConstraint(350)];  // Only runs if earlier components succeed
   }
   ```

---

## Known Issues and Future Work

### Current Issues

1. **Deprecation Warnings**: Expected in legacy code using MARTEM patterns
   - Resolution: Gradual migration to modern Component API

2. **Test Coverage**: Some refactor branch tests not wired to npm scripts
   - Workaround: Run directly with `ts-node examples/test-*.ts`

3. **Documentation Fragmentation**: Multiple phase completion documents
   - Resolution: This consolidated document

### Phase 4 Work (In Progress)

- 🔄 Documentation consolidation (this document)
- 🔄 Enhanced debug tooling
- 🔄 Performance profiling and optimization
- 🔄 Migration automation tools
- 🔄 Component dependency declarations

### Future Enhancements

1. **Component Dependencies**
   ```typescript
   // Potential future API
   class DependentComponent extends Component {
     dependencies = ['ComponentA', 'ComponentB'];
     priority = 'auto';  // Calculated from dependencies
   }
   ```

2. **Parallel Execution Groups**
   ```typescript
   // Components at same priority could run in parallel
   class ParallelSafeComponent extends Component {
     priority = 200;
     parallel = true;  // Opt-in to parallel execution
   }
   ```

3. **Dynamic Priority Adjustment**
   ```typescript
   // Adjust priority based on runtime conditions
   component.setPriority(150);  // Re-sort component list
   ```

---

## Quick Reference

### Component Template

```typescript
import { Component, ExecutionContext } from 'connectome';
import { priorityConstraint, ComponentPriority } from './constraints';

export class MyComponent extends Component {
  // Set execution order via priority constraint (lower = earlier)
  constraints = [priorityConstraint(ComponentPriority.TRANSFORM)];  // 200

  // Main execution method
  execute(context: ExecutionContext): void {
    const { event, state, bufferedEvents } = context;

    // Filter events if needed
    if (event.topic !== 'my.topic') return;

    // Read current state
    const existingFacet = state.facets.get('my-facet');

    // Modify state (visible to later components)
    this.addOperation({
      type: 'addFacet',
      facet: {
        type: 'my-facet',
        ephemeral: false,  // Persists across frames
        data: processData(event.payload)
      }
    });

    // Emit events for future frames
    this.emit({
      topic: 'my.processed',
      payload: { timestamp: Date.now() }
    });
  }

  // Lifecycle: Called when added to space
  onMount(): void {
    console.log('Mounted to space:', this.space.id);
  }

  // Lifecycle: Called when removed from space
  onUnmount(): void {
    console.log('Unmounted from space');
  }
}
```

### Priority Constraint Cheatsheet

```typescript
// Standard ComponentPriority values
ComponentPriority.MODULATOR:  0   - Event filtering, validation, aggregation
ComponentPriority.RECEPTOR:   100 - Event → VEIL facet transformation
ComponentPriority.TRANSFORM:  200 - VEIL state processing, business logic
ComponentPriority.EFFECTOR:   300 - External API calls, side effects
ComponentPriority.MAINTAINER: 400 - Cleanup, persistence, metrics

// Usage
constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];  // Named constant
constraints = [priorityConstraint(150)];  // Custom numeric value
```

### Common Patterns

```typescript
// Pattern 1: Event-triggered processing
if (context.event.topic === 'trigger') {
  // Process event
}

// Pattern 2: State-dependent logic
const activation = context.state.facets.get('activation');
if (activation && activation.active) {
  // Process with activation
}

// Pattern 3: Multi-step workflow
this.addOperation({ type: 'addFacet', facet: step1Facet });
this.emit({ topic: 'step2.trigger' });  // Next frame

// Pattern 4: Ephemeral communication
this.addOperation({
  type: 'addFacet',
  facet: {
    type: 'message',
    ephemeral: true,  // Auto-cleaned at frame end
    content: 'Temporary message'
  }
});

// Pattern 5: Component coordination via priority constraint
class Producer extends Component {
  constraints = [priorityConstraint(100)];  // Runs first
}
class Consumer extends Component {
  constraints = [priorityConstraint(200)];  // Sees Producer's output
}
```

### Testing Commands

```bash
# Run all tests
npm run test:phase0

# Priority tests only (core functionality)
npm run test:phase0:priority

# Skip connection tests
npm run test:phase0:skip-connect

# Debug with inspector
node --inspect=9229 -r ts-node/register examples/test-flex.ts

# Enable tracing
ENABLE_TRACING=true npm run test:phase0
```

---

## References

### Core Implementation
- `src/spaces/space.ts:471` - Main `processFrame()` implementation
- `src/spaces/component.ts` - Component base class
- `src/spaces/types.ts:11` - ExecutionContext interface with readonly frame
- `src/veil/types.ts:88` - Frame and ReadonlyFrame types
- `src/components/base-martem.ts` - Backward compatibility shims

### Documentation
- `MARTEM_ARCHITECTURE.md` - Legacy architecture (deprecated)
- `FLEX-MIGRATION-GUIDE.md` - Detailed migration instructions
- `FLEX-TEST-PLAN.md` - Comprehensive test suite
- `DEBUG-REGISTRY.md` - Inspector debugging guide

### Phase Completion Records
- `FLEX-PHASE-1-COMPLETE.md` - Dual-mode implementation
- `FLEX-PHASE-2-COMPLETE.md` - Tree removal
- `FLEX-PHASE-3-COMPLETE.md` - Sequential execution

---

**Document Version:** 3.0
**Architecture Version:** FLEX Phase 4 (Constraint-based priority)
**Last Updated:** 2025-11-26

### Changelog (v3.0)
- **Breaking Change**: Priority is now a constraint type, not a first-class field
- Replaced `priority: number` field with `constraints: ConstraintFacet[]` array
- Added `priorityConstraint()` factory and `ComponentPriority` constants
- All components must use `constraints = [priorityConstraint(X)]` instead of `priority = X`
- Removed backward-compatibility shim that created PriorityConstraintFacet from `component.priority`