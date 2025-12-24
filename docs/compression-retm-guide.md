# Compression Guide

This guide shows how to use the compression system with Connectome's component architecture.

## Overview

Compression in Connectome is handled by **Transform components** (priority 200-299) that run during frame processing. This decouples compression from agents and makes it shared infrastructure.

### The Flow

```
Frame Processing (Sequential):
Priority 100-199: Events → VEIL (Receptors)
Priority 200-299: VEIL → VEIL (Transforms)
  ├── CompressionTransform (priority 10): Compresses old frames, updates engine cache
  └── ContextRenderer (priority 100): Renders context for agents (using compressed frames)
Priority 300-399: VEIL Changes → Side Effects (Effectors)
  └── AgentEffector: Runs agent with pre-rendered context
```

## Setup

### 1. Create Compression Engine

```typescript
import { 
  AttentionAwareCompressionEngine,
  SimpleTestCompressionEngine 
} from 'connectome-ts';

// Use attention-aware engine (recommended)
const compressionEngine = new AttentionAwareCompressionEngine();

// Or use simple test engine
// const compressionEngine = new SimpleTestCompressionEngine();
```

### 2. Register Transforms with Space

```typescript
import { 
  CompressionTransform,
  ContextRenderer,
  Space,
  VEILStateManager
} from 'connectome-ts';

const veilState = new VEILStateManager();
const space = new Space(veilState);

// Add CompressionTransform (priority=10, runs first among transforms)
const compressionTransform = new CompressionTransform({
  engine: compressionEngine,
  engineName: 'attention-aware',
  triggerThreshold: 500,        // Start compression when total tokens > 500
  minFramesBeforeCompression: 10, // Wait for at least 10 frames
  maxPendingRanges: 5,           // Max compression tasks at once
  maxConcurrent: 1,              // Max concurrent LLM requests
  retryLimit: 2                  // Retry failed compressions
});

space.addTransform(compressionTransform);

// Add ContextRenderer (priority=100, runs after compression)
const contextTransform = new ContextRenderer(
  veilState,
  compressionEngine,  // Same engine instance!
  {
    maxTokens: 4000,   // Default context window
    // Other HUD config options
  }
);

space.addTransform(contextTransform);

// Note: Transforms with priority run before those without
// CompressionTransform (10) → ContextRenderer (100) → unprioritized transforms
```

### 3. Create Agent (No Compression Needed!)

```typescript
import { BasicAgent, AgentEffector } from 'connectome-ts';

// Agent doesn't need to know about compression
const agent = new BasicAgent(
  {
    name: 'Assistant',
    systemPrompt: 'You are a helpful AI assistant.',
    contextTokenBudget: 4000
  },
  llmProvider,
  veilState
);

// Use AgentEffector to connect agent to component architecture
const agentEffector = new AgentEffector(agentElement, agent);
space.addEffector(agentEffector);
```

## How It Works

### CompressionTransform

1. **Monitors** frame history for compressible ranges
2. **Identifies** ranges that exceed token threshold
3. **Compresses** ranges asynchronously using the engine
4. **Creates** compression-plan and compression-result facets
5. **Populates** engine cache with replacements

### ContextRenderer

1. **Watches** for agent-activation facets
2. **Renders** context using FrameTrackingHUD
3. **Uses** compression engine cache for frame replacements
4. **Creates** rendered-context facets with full context

### AgentEffector

1. **Watches** for agent-activation + rendered-context facet pairs
2. **Runs** agent with pre-rendered context
3. **Emits** agent response facets back to VEIL

## Configuration Options

### CompressionTransform Options

```typescript
interface CompressionTransformOptions {
  engine: CompressionEngine;           // The compression engine to use
  engineName?: string;                 // Name for logging/facets
  hud?: FrameTrackingHUD;             // Custom HUD instance
  compressionConfig?: CompressionConfig; // Engine-specific config
  triggerThreshold?: number;           // Token threshold (default: 500)
  minFramesBeforeCompression?: number; // Min frames to wait (default: 10)
  maxPendingRanges?: number;          // Max queued tasks (default: 5)
  maxConcurrent?: number;             // Max parallel requests (default: 1)
  retryLimit?: number;                // Retry attempts (default: 2)
  retryDelayMs?: number;              // Retry delay (default: 200ms)
}
```

### Compression Engines

**AttentionAwareCompressionEngine**
- Uses LLM to identify important content
- Preserves high-attention frames
- Best for production use

**SimpleTestCompressionEngine**
- Simple token-based compression
- No LLM calls for compression
- Good for testing

## Complete Example

```typescript
import {
  Space,
  VEILStateManager,
  BasicAgent,
  AgentEffector,
  CompressionTransform,
  ContextRenderer,
  AttentionAwareCompressionEngine,
  Element
} from 'connectome-ts';

// Setup
const veilState = new VEILStateManager();
const space = new Space(veilState);

// Compression engine (shared instance)
const compressionEngine = new AttentionAwareCompressionEngine();

// Transforms (priority 200-299)
space.addTransform(new CompressionTransform({
  engine: compressionEngine,
  triggerThreshold: 500
}));

space.addTransform(new ContextRenderer(
  veilState,
  compressionEngine,
  { maxTokens: 4000 }
));

// Agent (Effector priority 300-399)
const agentElement = new Element('agent-1', 'agent');
space.mountElement(agentElement);

const agent = new BasicAgent(
  {
    name: 'Assistant',
    systemPrompt: 'You are a helpful assistant.',
    contextTokenBudget: 4000
  },
  llmProvider,
  veilState
);

const agentEffector = new AgentEffector(agentElement, agent);
space.addEffector(agentEffector);

// Now when agent-activation facets are created,
// the system will automatically:
// 1. Compress old frames (CompressionTransform)
// 2. Render context with compression (ContextRenderer)
// 3. Run agent with rendered context (AgentEffector)
```

## Migration from Old Architecture

### Before (Direct Compression)

```typescript
// Old way - agent manages compression
const agent = new BasicAgent(
  config,
  provider,
  veilState,
  compressionEngine  // ❌ No longer supported
);
```

### After (Transform Components)

```typescript
// New way - transforms handle compression
space.addTransform(new CompressionTransform({ engine: compressionEngine }));
space.addTransform(new ContextRenderer(veilState, compressionEngine));

const agent = new BasicAgent(config, provider, veilState);
// Agent doesn't need compression - it's handled by transforms!
```

## Monitoring Compression

Compression creates facets that you can observe:

### Compression Plan Facet
```typescript
{
  type: 'compression-plan',
  state: {
    engine: 'attention-aware',
    ranges: [
      {
        from: 10,
        to: 50,
        totalTokens: 1200,
        status: 'in-progress',
        // ...
      }
    ]
  },
  ephemeral: true
}
```

### Compression Result Facet
```typescript
{
  type: 'compression-result',
  state: {
    range: { from: 10, to: 50, totalTokens: 1200 },
    summary: 'User discussed weather and asked about forecast...',
    stateDelta: { /* state changes */ },
    engine: 'attention-aware'
  },
  ephemeral: true
}
```

## Benefits of Component-Based Compression

1. **Separation of Concerns**: Agents don't manage compression
2. **Reusability**: One compression engine serves all agents
3. **Consistency**: All agents get same compression behavior
4. **Observability**: Compression facets show what's happening
5. **Testability**: Can test compression independently of agents

## Running the Example

A complete working example is available:

```bash
npm run example:compression
```

This demo shows:
- Setting up compression transforms with priority
- Creating agents without compression parameters
- Generating messages to trigger compression
- Observing compression facets in VEIL state
- Complete architecture flow explanation

See `examples/compression-retm-demo.ts` for the full code.

## Next Steps

- **Run the example** - `npm run example:compression`
- Read about [Frame Processing Phases](./frame-processing.md)
- Learn about [Transform Ordering](./transform-ordering.md)
- Explore [Compression Engines](./compression-engines.md)

