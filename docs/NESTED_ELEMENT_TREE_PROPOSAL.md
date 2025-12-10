# Nested Element-Tree Structure Proposal

## Problem Statement

**Current Issue**: Element creation order affects initialization correctness due to component lifecycle timing.

**Specific Case**: `DiscordAfferent` connects synchronously in `setConnectionParams()`, emitting `discord:connected` before `DiscordConnectedReceptor` exists if creation order is wrong.

**Current Workaround**: `DiscordInfrastructureTransform` polls VEIL every frame to check if all infrastructure components exist, then triggers Discord element creation. This works but:
- Uses Transform as orchestrator (architectural mismatch)
- Polls every frame (inefficient)
- Hardcodes dependency lists (brittle)
- Becomes zombie code after triggering once

## Root Cause Analysis

### Event Loss Mechanism
```typescript
// Space.runPhase1() - line 610-611 in space.ts
const receptorsForTopic = this.receptors.get(event.topic) || [];
if (receptorsForTopic.length === 0) continue;  // ← EVENT DROPPED!
```

If an event is emitted with no receptors registered, it's **silently lost** - never becomes a facet, never enters VEIL.

### The Race Condition
```
Frame N:
  Phase 4: Maintainer creates DiscordAfferent
           → setConnectionParams() called
           → connects immediately
           → emits discord:connected
           
Frame N+1:
  Phase 1: Process discord:connected
           → No receptors exist yet
           → Event dropped ❌
```

## Proposed Solution: Nested Element-Tree Facets

### Current Structure (Flat)
```typescript
// Separate facets with only upward references
element-tree-root: {
  parentId: null,
  components: [DiscordConnectedReceptor, ...]
}
element-tree-discord: {
  parentId: 'root',  // ← Just a reference
  components: [DiscordAfferent]
}
```

**Issue**: `Map.entries()` iteration order is arbitrary. No guaranteed parent-before-child processing.

### Proposed Structure (Nested)
```typescript
element-tree-root: {
  parentId: null,
  components: [DiscordConnectedReceptor, ...],
  children: [  // ← Nested, not referenced
    {
      elementId: 'discord',
      elementType: 'Element',
      parentId: 'root',
      name: 'discord',
      active: true,
      components: [DiscordAfferent],
      children: []
    }
  ]
}
```

**Benefit**: Natural depth-first traversal guarantees parent components are created before child elements.

## Implementation Approach

### Receptor Changes (ElementRequestReceptor)

**Current**: Creates separate element-tree facet
```typescript
deltas.push({
  type: 'addFacet',
  facet: {
    id: `element-tree-${elementId}`,
    type: 'element-tree',
    state: { elementId, parentId, ... }
  }
});
```

**Proposed**: Update parent's children array
```typescript
const parentFacet = state.facets.get(`element-tree-${parentId}`);
deltas.push({
  type: 'rewriteFacet',
  id: `element-tree-${parentId}`,
  changes: {
    state: {
      children: [
        ...(parentFacet.state.children || []),
        {
          elementId,
          elementType,
          name,
          components,
          children: []
        }
      ]
    }
  }
});
```

### Maintainer Changes (ElementTreeMaintainer)

**Current**: Flat iteration
```typescript
for (const [id, facet] of state.facets) {
  if (facet.type === 'element-tree') {
    // Process in arbitrary order
  }
}
```

**Proposed**: Recursive depth-first
```typescript
async processElementTree(treeFacet: Facet): Promise<void> {
  // 1. Ensure element exists
  const element = await this.ensureElement(treeFacet);
  
  // 2. Process ALL its components
  for (const compDef of treeFacet.state.components) {
    await this.addComponent(element, compDef);
  }
  
  // 3. THEN recurse to children (components exist before children created!)
  for (const childState of treeFacet.state.children || []) {
    await this.processElementTree({
      id: `element-tree-${childState.elementId}`,
      type: 'element-tree',
      state: childState
    });
  }
}

async process(frame, changes) {
  // Start from root
  const rootFacet = state.facets.get('element-tree-root');
  if (rootFacet) {
    await this.processElementTree(rootFacet);
  }
}
```

### Completed TODO: sortByHierarchy stub
```typescript
// Currently at line 791-795 in element-tree-receptors.ts
private sortByHierarchy(operations: any[]): any[] {
  // For now, just return as-is
  // TODO: Implement proper sorting based on parent-child relationships
  return operations;
}
```

With nested structure, this becomes unnecessary - tree structure IS the order.

## Benefits

### 1. Order is Structural, Not Computed
- No need to sort by depth
- No need to calculate dependencies
- Tree traversal = correct order automatically

### 2. Works for All Scenarios
- ✅ Startup: Full tree declared at once
- ✅ Runtime: Add child to existing parent
- ✅ Restoration: Entire tree restored atomically
- ✅ Dynamic: Restructure and reprocess

### 3. Removes Workarounds
- ✗ No more `DiscordInfrastructureTransform` polling
- ✗ No more hardcoded dependency lists
- ✗ No more `setTimeout(100)` hoping components are ready
- ✗ No more one-shot zombie code

### 4. Cleaner Semantics
```typescript
// Instead of:
emit element:create for Discord  // Separate, order matters!
emit component:add for receptors  // Separate, order matters!

// Do:
emit element:create for root with complete structure {
  components: [receptors...],  // ← Created first
  children: [                  // ← Created after
    { elementId: 'discord', components: [DiscordAfferent] }
  ]
}
```

### 5. Mirrors Reality
Element tree in VEIL matches actual Element tree structure - one source of truth.

## Open Questions

1. **How to handle child addition to existing parent?**
   - Rewrite parent's `children` array?
   - Separate `element-tree-${childId}` facet but with depth ordering?

2. **Persistence impact?**
   - Nested structure already serialized correctly (we just fixed this!)
   - Need to ensure restoration uses depth-first too

3. **Migration path?**
   - Can we support both flat and nested?
   - Or clean break?

4. **Component references?**
   - Effectors reference `discordElementId: 'discord'` in config
   - Still works - ID lookup unchanged
   - Just creation order changes

## Alternatives Considered

### A. Implement sortByHierarchy (minimal change)
```typescript
private sortByHierarchy(operations: any[]): any[] {
  // Compute depth for each element
  // Sort by depth (parents first)
}
```
**Pro**: Works with current flat structure  
**Con**: Computed order, doesn't scale to complex dependencies

### B. Don't connect in setConnectionParams
```typescript
// DiscordAfferent waits for explicit signal to connect
async setConnectionParams(params) {
  this.params = params;  // Store, don't connect
}

async onApplicationReady() {  // Called by Host
  await this.connect();
}
```
**Pro**: Fixes root cause  
**Con**: Requires new lifecycle hook, doesn't generalize

### C. Buffer events until receptors ready
```typescript
// Space buffers events with no receptors
// Re-emits when receptors appear
```
**Pro**: No event loss  
**Con**: Complex buffering logic, unclear semantics

## Recommendation

**Implement nested element-tree structure.**

This is the most architecturally sound solution because:
1. Structure encodes dependencies naturally
2. Works for all creation scenarios (startup, runtime, restoration)
3. Removes need for workarounds (Transform, setTimeout, polling)
4. Aligns VEIL representation with actual system structure
5. Scales to complex hierarchies

---

*Documented: October 28, 2025*  
*Discussion: Olena & Claude*  
*Status: Proposal - Not Yet Implemented*

## Related: frame:start Removal

**Issue**: `frame:start` is a meta-event that components subscribe to for initialization workarounds.

**Problems:**
- Components shouldn't know about frame lifecycle
- Delivered during frame processing (timing fragility)
- Used as hack for "when can I create facets?"
- Component deltas added during `frame:start` were being lost (now fixed but fragile)

**Proper Solutions:**
- Receptor pattern for initialization
- Component lifecycle hooks that run at proper phase boundaries
- Remove `frame:start` entirely

**Priority**: Medium - current workaround functional but should be cleaned up

---

