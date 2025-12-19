/**
 * Clean HUD interfaces that work with VEIL primitives
 * No ContentBlock abstraction
 */

import { Facet, Frame, OutgoingVEILOperation } from '../veil/types';
import { CompressionEngine, RenderedFrame } from '../compression/types-v2';

// Union type for frames
/**
 * Result of rendering VEIL state
 */
export interface RenderedContext {
  // Standard LLM message format
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    // Track which frames contributed to this message
    sourceFrames?: {
      from: number;
      to: number;
    };
    // Metadata for cache control and other LLM provider features
    metadata?: {
      cacheControl?: {
        type: 'ephemeral' | 'persistent';
        ttl?: number;
      };
      [key: string]: any;
    };
  }>;
  
  // Metadata about rendering
  metadata: {
    totalTokens: number;
    renderedFrames: RenderedFrame[];
    droppedFrames?: number[];
    // Quick lookup for frame->message mapping
    frameToMessageIndex?: Map<number, number>;
  };
}

/**
 * Configuration for HUD rendering
 */
export interface HUDConfig {
  maxTokens?: number;  // Token budget for context window (e.g., 4000-8000) - currently only warns if exceeded
  includeTypes?: Array<'event' | 'state' | 'ambient'>;
  systemPrompt?: string;
  
  // Legacy caching fields (deprecated)
  enableCaching?: boolean;
  cacheStrategy?: 'frame-boundary' | 'token-threshold' | 'none';
  
  /**
   * Frame render cache configuration (Layer 2 caching)
   * Caches rendered frame text per context to avoid re-rendering
   * Complements VEILStateManager's state cache (Layer 1)
   */
  frameRenderCache?: {
    enabled: boolean;                // Enable render caching
    cacheBorderDepth?: number;       // How many recent frames to NOT cache (default: 20)
    maxContexts?: number;            // Max contexts to cache (default: 10)
    verbose?: boolean;               // Enable verbose logging
  };
  
  /**
   * Render context configuration
   * Determines how frames are rendered and affects cache keys
   */
  renderContext?: {
    focusedStream?: string;          // Which stream is in focus (for multi-stream)
    displayMode?: 'full' | 'focused' | 'ambient';  // Rendering mode
  };
  
  /**
   * Current agent ID for multi-agent support
   * Used to determine which agent's perspective we're rendering from
   */
  currentAgentId?: string;
  
  /**
   * Prompt caching configuration (Anthropic-level)
   * Places cache markers at cacheBorderDepth boundary
   */
  promptCaching?: {
    enabled: boolean;                // Enable Anthropic prompt caching
  };
  
  metadata?: {
    pendingActivations?: {
      count: number;
      sources: string[];
    };
  };
  formatConfig?: {
    assistant?: {
      prefix?: string;
      suffix?: string;
    };
    /**
     * Thinking mode configuration - enables chain-of-thought reasoning via prefill
     * 
     * NOTE: This is NOT Anthropic's official Extended Thinking API (which uses budget_tokens
     * and is incompatible with prefill). This is "simulated thinking" - prefilling an opening
     * thinking tag to encourage the model to produce visible reasoning before responding.
     * 
     * When enabled, the prefill becomes: <thinking>\n
     * And the model produces: <thinking>reasoning...</thinking><my_turn>response</my_turn>
     */
    thinking?: {
      enabled: boolean;
      /** Opening tag for thinking block (default: "<thinking>\n") */
      openTag?: string;
      /** Closing tag for thinking block (default: "\n</thinking>\n") */
      closeTag?: string;
    };
  };
}

/**
 * Clean HUD interface working directly with VEIL data
 */
export interface HUD {
  /**
   * Render VEIL state to LLM context
   * @param frames - The VEIL frame history
   * @param currentFacets - Current state of all facets
   * @param veilStateManager - VEILStateManager for historical state queries
   * @param compression - Optional compression engine
   * @param config - Rendering configuration
   */
  render(
    frames: Frame[],
    currentFacets: Map<string, Facet>,
    veilStateManager: any, // VEILStateManager (any to avoid circular deps)
    compression?: CompressionEngine,
    config?: HUDConfig
  ): RenderedContext;
  
  /**
   * Parse LLM completion into VEIL operations
   */
  parseCompletion(completion: string): {
    operations: OutgoingVEILOperation[];
    hasMoreToSay: boolean;
  };
  
  /**
   * Get the format this HUD uses (xml, json, etc)
   */
  getFormat(): string;
}

/**
 * Extended interface for HUDs that support frame-aware compression
 */
export interface CompressibleHUD extends HUD {
  /**
   * Render with explicit frame tracking for compression
   * Returns both the context and frame-by-frame rendering
   */
  renderWithFrameTracking(
    frames: Frame[],
    currentFacets: Map<string, Facet>,
    veilStateManager: any, // VEILStateManager (any to avoid circular deps)
    compression?: CompressionEngine,
    config?: HUDConfig
  ): {
    context: RenderedContext;
    frameRenderings: RenderedFrame[];
  };
  
  /**
   * Check if compression is needed based on current state
   */
  needsCompression(
    frames: Frame[],
    config: HUDConfig
  ): boolean;
}
