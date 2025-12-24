# Migrating FrameTrackingHUD to ContextRenderer

## Overview

The FrameTrackingHUD needs to become a Transform in the new Receptor/Effector architecture. This preserves all the intricate rendering logic while fitting into the new model.

## Current Architecture

```typescript
// Old: HUD is called by agent
const context = this.hud.render(
  state.frameHistory,
  new Map(state.facets),
  this.compressionEngine,
  options
);
```

## New Architecture

```typescript
// New: ContextRenderer runs at transform priority (200-299)
class ContextRenderer implements Transform {
  process(state: ReadonlyVEILState): Facet[] {
    // Render context for all active agents
    const contextFacets: Facet[] = [];
    
    // Find activation facets that need context
    for (const facet of state.facets.values()) {
      if (facet.type === 'agentActivation' && !facet.attributes?.contextRendered) {
        const context = this.renderContext(state, facet);
        contextFacets.push({
          id: `context-${facet.id}`,
          type: 'rendered-context',
          content: context.content,
          temporal: 'ephemeral',
          attributes: {
            activationId: facet.id,
            agentId: facet.attributes?.targetAgentId,
            tokenCount: context.tokenCount,
            // ... other metadata
          }
        });
      }
    }
    
    return contextFacets;
  }
}
```

## Key Changes

1. **Stateless Operation**: Transform has no persistent state, renders on demand
2. **Facet-Driven**: Creates context facets for activation facets
3. **Ephemeral**: Context facets are marked ephemeral (cleaned up after frame)
4. **Preserves Logic**: All rendering logic remains intact

## Benefits

- Clean separation of concerns
- Context rendering happens automatically
- Multiple agents can have different contexts
- Easy to test (pure function)
- Preserves all the complex rendering logic

