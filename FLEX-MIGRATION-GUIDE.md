# FLEX Phase 1: Migration Guide

## Overview

This guide explains how to migrate your Connectome applications from the tree-based Element hierarchy to the new flat component list architecture (FLEX).

## Why Migrate?

The FLEX architecture provides:
- **Predictable execution order** - Components execute in a well-defined sequence
- **Simpler mental model** - Flat list instead of tree hierarchy
- **Better for LLMs** - Sequential processing matches LLM interaction patterns
- **Explicit dependencies** - Constraint-based ordering instead of implicit tree structure
- **Easier debugging** - Clear execution order, no tree traversal confusion

## Phase 1: Dual Mode (Current)

Phase 1 maintains 100% backward compatibility. Both modes work simultaneously:

### Legacy Mode (Still Works)
```typescript
// Traditional tree-based approach
const space = new Space(veilState, registry);
const myElement = new Element('my-feature');
space.addChild(myElement);

const myComponent = new MyComponent();
myElement.addComponent(myComponent);

// Component accesses Space via tree traversal
const space = myComponent.element.findSpace();
```

### Direct Mode (New, Recommended)
```typescript
// New flat list approach
const space = new Space(veilState, registry);
space.enableDirectMounting();

const myComponent = new MyComponent();
space.addComponentDirect(myComponent, 'my-feature-component');

// Component accesses Space directly
const space = myComponent.space; 
```

### Legacy (Deprecated)
```typescript
// Component accesses Space via tree traversal (REMOVED in Phase 2)
// const space = myComponent.element.findSpace();
```

## Migration Steps

### Step 1: Enable Direct Mounting

In your application initialization:

```typescript
// Before
const space = new Space(veilState, registry);

// After
const space = new Space(veilState, registry);
space.enableDirectMounting(); // Enable new mode
```

### Step 2: Convert Components One-by-One

You can migrate components incrementally. Both modes work together:

```typescript
// Some components still using tree (legacy)
const legacyElement = new Element('legacy-feature');
space.addChild(legacyElement);
legacyElement.addComponent(new LegacyComponent());

// New components using direct mounting
space.addComponentDirect(new ModernComponent(), 'modern-component');
```

### Step 3: Update Component Access Patterns

#### Accessing Space

```typescript
// Before (tree traversal)
class MyComponent extends Component {
  doSomething() {
    const space = this.element.findSpace() as Space;
    // ...
  }
}

// After (direct access)
class MyComponent extends Component {
  doSomething() {
    const space = this.space; // Works in both modes!
    // ...
  }
}
```

The `space` getter automatically works for both:
- Direct mounting: Returns direct reference
- Tree mounting: Falls back to tree traversal

#### Accessing VEIL State

```typescript
// Before
const space = this.element.findSpace() as Space;
const veilState = space.getVEILStateManager();

// After
const veilState = this.space.getVEILStateManager();
```

#### Emitting Events

```typescript
// Before and After - same!
this.emit({
  topic: 'my-event',
  payload: { data: 'value' }
});
```

### Step 4: Remove Element References (Optional)

If your component doesn't need Element features:

```typescript
// Before - using Element features
class MyComponent extends Component {
  onMount() {
    const children = this.element.children; // Tree-specific
    const parent = this.element.parent;     // Tree-specific
  }
}

// After - pure component
class MyComponent extends Component {
  onMount() {
    // Access what you need directly from space
    const state = this.space.getVEILStateManager().getState();
  }
}
```

### Step 5: Update Component Registration

For MARTEM components, registration happens automatically:

```typescript
// Before - manual registration
const receptor = new MyReceptor();
myElement.addComponent(receptor);
space.addReceptor(receptor); // Manual registration

// After - automatic registration
space.addComponentDirect(new MyReceptor(), 'my-receptor');
// Automatically registered as a receptor!
```

## Component Patterns

### Basic Component

```typescript
// Phase 1 compatible component
class MyComponent extends Component {
  onInit() {
    // Initialization (runs once)
  }

  onMount() {
    // When ready to operate
  }

  async handleEvent(event: SpaceEvent) {
    // Handle events
    if (event.topic === 'my-topic') {
      // Process event
      const veil = this.space.getVEILStateManager();
      // ...
    }
  }
}

// Use it
space.addComponentDirect(new MyComponent(), 'my-component');
```

### MARTEM Component (Receptor)

```typescript
class MyReceptor extends BaseReceptor {
  topics = ['my-event'];

  transform(event: SpaceEvent, state: ReadonlyVEILState): VEILDelta[] {
    return [{
      type: 'addFacet',
      facet: {
        id: `my-facet-${Date.now()}`,
        type: 'my-type',
        state: { /* ... */ }
      }
    }];
  }
}

// Automatically registered as a receptor
space.addComponentDirect(new MyReceptor(), 'my-receptor');
```

### MARTEM Component (Transform)

```typescript
class MyTransform extends BaseTransform {
  transform(state: ReadonlyVEILState): VEILDelta[] {
    // Transform VEIL state
    return deltas;
  }
}

// Automatically registered as a transform
space.addComponentDirect(new MyTransform(), 'my-transform');
```

## Common Patterns

### Accessing References

```typescript
// Before
const space = this.element.findSpace() as Space;
const myRef = space.getReference('my-reference');

// After (same code works!)
const myRef = this.space.getReference('my-reference');
```

### Subscribing to Events

```typescript
// Phase 1: Still works via Element
this.subscribe('my-topic');

// Phase 2: Will use component-level subscriptions
// (handled automatically)
```

### Getting Component ID

```typescript
class MyComponent extends Component {
  onMount() {
    // Direct mounting mode
    console.log('My ID:', this.componentId);

    // Legacy mode
    console.log('Element ID:', this.element?.id);
  }
}
```

## Troubleshooting

### Issue: Component can't access Space

```typescript
// Problem
const space = this.space; // Error: not mounted

// Solution: Ensure component is registered
space.addComponentDirect(component, 'component-id');
```

### Issue: Deprecation Warnings

```bash
# Temporarily disable warnings during migration
FLEX_DEPRECATION_WARNINGS=false npm run example:host

# Or fix the warnings by migrating to direct mounting
```

### Issue: Events not being received

```typescript
// Problem: Component not receiving events
class MyComponent extends Component {
  // Missing handleEvent implementation
}

// Solution: Implement handleEvent
class MyComponent extends Component {
  async handleEvent(event: SpaceEvent) {
    // Process events
  }
}
```

## Testing Your Migration

### 1. Run Existing Tests

```bash
# All existing tests should pass
npm run test:phase0
```

### 2. Verify Dual Mode

```typescript
// Both should work together
space.enableDirectMounting();

// Legacy components
const legacy = new Element('legacy');
space.addChild(legacy);
legacy.addComponent(new LegacyComponent());

// Direct components
space.addComponentDirect(new ModernComponent(), 'modern');

// Both should work!
```

### 3. Check Debug Server

```bash
# Start app with debug server
DEBUG_SERVER_ENABLED=true npm run example:host

# Visit http://localhost:3015
# Check /api/state endpoint for:
# - useDirectMounting: true
# - directComponents: [...]
# - directComponentCount: N
```

## Phase 2 Preview

In Phase 2, the Element tree will be completely removed:

### What Will Stop Working
- `element.addChild()`
- `element.findChild()`
- `element.parent`
- `element.children`
- Tree traversal methods

### What Will Keep Working
- `space.addComponentDirect()`
- `component.space`
- `component.handleEvent()`
- MARTEM phases (with simplified API)
- Event emission
- VEIL state access

### What Will Be New
- Sequential execution (replaces MARTEM phases)
- Constraint-based ordering
- Immediate VEIL delta application
- Mutable event buffer

## Best Practices

### 1. Migrate Early
Start migrating components now to avoid breaking changes in Phase 2.

### 2. Test Incrementally
Migrate one component at a time and test after each change.

### 3. Use Direct Space Access
Always use `this.space` instead of `this.element.findSpace()`.

### 4. Avoid Tree Dependencies
Don't rely on `parent`, `children`, or tree navigation in new code.

### 5. Explicit IDs
Provide explicit component IDs for easier debugging:
```typescript
space.addComponentDirect(myComponent, 'descriptive-id');
```

## Getting Help

### Documentation
- `FLEX-PHASE-1-COMPLETE.md` - Implementation details
- `MARTEM_ARCHITECTURE.md` - Current MARTEM architecture
- `CONSTRAINT_SOLVER_DESIGN.md` - Future Phase 2 design

### Debugging
1. Enable debug server: `DEBUG_SERVER_ENABLED=true`
2. Check `/api/state` endpoint
3. Look for `useDirectMounting` and `directComponents`
4. Verify component registration

### Common Questions

**Q: Should I migrate now or wait for Phase 2?**
A: Start migrating now. Phase 1 is backward compatible, but Phase 2 will remove tree support.

**Q: Can I mix tree and direct mounting?**
A: Yes! Phase 1 supports both simultaneously.

**Q: Will my existing code break?**
A: No! Phase 1 is 100% backward compatible.

**Q: When is Phase 2?**
A: After Phase 1 is fully tested and validated with the test suite.

## Summary

Phase 1 provides a smooth migration path:
1. Enable direct mounting: `space.enableDirectMounting()`
2. Migrate components one-by-one: `space.addComponentDirect()`
3. Update access patterns: Use `this.space` everywhere
4. Test thoroughly with existing test suite
5. Prepare for Phase 2 tree removal

The key insight: **Start migrating now, but at your own pace. Both modes work together!**
