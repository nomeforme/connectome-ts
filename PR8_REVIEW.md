# PR #8 Review: Rendered Cache Refactor and Per-Stream Rendering

## What It Does

**Goal:** Multi-stream support - agent can participate in multiple Discord channels/Slack workspaces/etc simultaneously, but only see full detail for the "focused" stream.

### Core Changes

**1. ActiveStreamTransform** (`src/transforms/active-stream-transform.ts`)
- New Transform that runs at priority 50 (before ContextTransform at 100)
- Sets `frame.activeStream` based on most recent event with `streamId`
- Generic - works for any adapter (Discord, Slack, file editor)

**2. Focused/Unfocused Rendering**
- `renderMode: 'focused' | 'unfocused'` parameter added to rendering
- **Focused streams:** Full detail (current behavior)
- **Unfocused streams:** Compressed XML format

```typescript
// Focused (current channel)
Cursor: Hello from #general

// Unfocused (background channel)
<event stream="discord:announcements" type="discord-message" label="announcements">Cursor: Update posted</event>
```

**3. Chunk-Based Caching**
- Changed from caching entire frame strings to caching `RenderedChunk[]`
- Each chunk has: `content`, `tokens`, `role`, `facetIds`, `metadata`
- More granular, enables per-chunk filtering/transformation

**4. Frame-to-Message Mapping**
- Tracks which message index each frame maps to
- Enables better cache invalidation and chunk management

### Files Changed

```
src/hud/context-transform.ts              |  26 +-     (minor updates)
src/hud/frame-render-cache.ts             |  60 ++--   (chunk-based caching)
src/hud/frame-tracking-hud.ts             | 508 ++++++++++++  (core changes)
src/hud/render-context-types.ts           |  24 +-     (CachedChunk type)
src/hud/types-v2.ts                       |   6 +      (activeStream)
src/spaces/element-tree-receptors.ts      |  38 +--     (?)
src/transforms/active-stream-transform.ts |  58 ++++   (NEW)
src/veil/rendered-snapshot-types.ts       |  12 +      (frame.activeStream)
```

## Review Questions

### 1. Architecture

**Q:** Is `frame.activeStream` the right place for this state?
- ✅ Frames already have metadata
- ❌ Couples rendering to frame structure
- 🤔 Alternative: VEIL facet for active stream?

**Q:** Why a Transform instead of setting in ContextTransform?
- ✅ Clean separation of concerns
- ✅ Priority-based execution (runs before rendering)
- ✅ Reusable if we add other stream-aware transforms

### 2. Rendering Logic

**Q:** `renderFacetUnfocused()` compresses to XML - is this the right format?
```xml
<event stream="..." type="..." label="...">content</event>
```
- ✅ Compact representation
- ✅ Preserves structure metadata
- ❌ Adds XML to context (more tokens than just hiding?)
- 🤔 Could we just omit unfocused facets entirely?

**Q:** Children of unfocused facets render in focused mode - why?
```typescript
const childRendered = this.renderFacet(child, 'focused');
```
- This seems odd - unfocused parent but focused children?

### 3. Caching

**Q:** Chunk-based caching vs string caching - worth the complexity?
- ✅ More flexible (can recompose chunks)
- ✅ Better invalidation
- ❌ More memory overhead
- ❌ More complex cache logic

### 4. element-tree-receptors Changes

**Q:** What changed in `element-tree-receptors.ts`? (38 lines)
- Need to examine these changes

### 5. Compatibility

**Q:** Breaking changes?
- Does this maintain backward compatibility?
- Are there tests?
- Does it work with current Discord setup?

## Relationship to Our Work

**Similarities:**
- Focused/unfocused pattern mirrors what we need for scope filtering
- Chunk-based rendering could support per-scope caching
- Generic filtering mechanism

**Key Insight:** We could extend this to:
```typescript
const renderMode = this.determineRenderMode(facet, {
  focusedStream,
  activeScopes
});
```

## Recommendation

**Before merging:**
1. Understand element-tree-receptors changes
2. Test with multi-stream Discord scenario
3. Check if unfocused rendering actually saves tokens
4. Verify cache hits are working
5. Consider: do we want XML wrapping or just omission?

**For scope support:**
- Can build on this pattern
- Add `activeScopes` tracking similar to `activeStream`  
- Reuse focused/unfocused rendering mechanism

Should we test this PR first before extending it with scope support?

