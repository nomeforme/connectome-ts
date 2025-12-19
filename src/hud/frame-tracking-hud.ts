/**
 * Clean HUD implementation that tracks frames for compression
 * Works directly with VEIL primitives, no ContentBlock abstraction
 */

import {
  Facet,
  Frame,
  OutgoingVEILOperation,
  hasContentAspect,
  hasStateAspect,
  FrameRenderedSnapshot,
  RenderedChunk,
  createRenderedChunk
} from '../veil/types';
import { CompressibleHUD, RenderedContext, HUDConfig } from './types-v2';
import { CompressionEngine, RenderedFrame, StateDelta } from '../compression/types-v2';
import { getGlobalTracer, TraceCategory } from '../tracing';
import { VEILStateManager } from '../veil/veil-state';
import { FrameRenderCache } from './frame-render-cache';
import { RenderContext, CachedChunk } from './render-context-types';
import { stripTurnMarkers } from '../utils/turn-markers';

export class FrameTrackingHUD implements CompressibleHUD {
  private frameRenderCache: FrameRenderCache;
  
  constructor() {
    this.frameRenderCache = new FrameRenderCache({
      maxContexts: 10,
      enableStats: true,
      verbose: false  // Default false, can be enabled via setVerbose()
    });
  }
  
  /**
   * Enable or disable verbose logging for cache
   */
  setCacheVerbose(verbose: boolean) {
    (this.frameRenderCache as any).config.verbose = verbose;
  }
  
  /**
   * Get cache statistics (for monitoring/debugging)
   */
  getCacheStats() {
    return this.frameRenderCache.getStats();
  }
  
  /**
   * Clear the render cache
   */
  clearRenderCache() {
    this.frameRenderCache.clear();
  }
  
  /**
   * Get cached context keys (for debugging)
   */
  getCachedContexts() {
    return this.frameRenderCache.getContextKeys();
  }
  
  /**
   * Invalidate a specific frame across all contexts
   */
  invalidateFrame(frameSequence: number) {
    this.frameRenderCache.invalidateFrame(frameSequence);
  }
  
  /**
   * Invalidate a range of frames across all contexts
   */
  invalidateFrameRange(fromSequence: number, toSequence: number) {
    this.frameRenderCache.invalidateRange(fromSequence, toSequence);
  }
  
  /**
   * Build render context from config and compression state
   */
  private buildRenderContext(config: HUDConfig, compression?: CompressionEngine): RenderContext {
    // Compute compression state hash
    const compressionState = this.computeCompressionStateHash(compression);
    
    return {
      focusedStream: config.renderContext?.focusedStream,
      compressionState,
      displayMode: config.renderContext?.displayMode || 'full',
      extensions: {}
    };
  }
  
  /**
   * Compute stable hash for compression state
   */
  private computeCompressionStateHash(compression?: CompressionEngine): string {
    if (!compression) {
      return 'none';
    }
    
    // Simple approach: just mark as "compressed" for now
    // Future: could hash actual compression mappings for finer granularity
    return 'compressed';
  }
  
  render(
    frames: Frame[],
    currentFacets: Map<string, Facet>,
    veilStateManager: VEILStateManager,
    compression?: CompressionEngine,
    config: HUDConfig = {}
  ): RenderedContext {
    const { context } = this.renderWithFrameTracking(
      frames,
      currentFacets,
      veilStateManager,
      compression,
      config
    );
    return context;
  }
  
  renderWithFrameTracking(
    frames: Frame[],
    currentFacets: Map<string, Facet>,
    veilStateManager: VEILStateManager,
    compression?: CompressionEngine,
    config: HUDConfig = {}
  ): {
    context: RenderedContext;
    frameRenderings: RenderedFrame[];
  } {
    const tracer = getGlobalTracer();
    const traceId = `hud-render-${Date.now()}`;
    
    tracer?.record({
      id: traceId,
      timestamp: Date.now(),
      level: 'info',
      category: TraceCategory.HUD_RENDER,
      component: 'FrameTrackingHUD',
      operation: 'renderWithFrameTracking',
      data: {
        frameCount: frames.length,
        currentFacetCount: currentFacets.size,
        config
      }
    });
    
    const frameRenderings: RenderedFrame[] = [];
    const allChunks: RenderedChunk[] = [];
    let totalTokens = 0;
    
    // Note on token budget: We currently include ALL frames even if we exceed the budget.
    // Dropping frames (whether old or new) is problematic:
    // - Dropping old frames loses important context and setup
    // - Dropping new frames (the previous behavior) causes amnesia about recent messages
    // If frame dropping becomes necessary, it should be done intelligently (e.g., using
    // compression, importance scoring, or keeping a sliding window of recent + important frames).
    
    // Layer 2 cache setup (render caching)
    const cacheEnabled = config.frameRenderCache?.enabled ?? false;
    const cacheBorderDepth = config.frameRenderCache?.cacheBorderDepth ?? 20;
    const cacheableUntil = Math.max(0, frames.length - cacheBorderDepth);
    const renderContext = this.buildRenderContext(config, compression);
    
    // Update verbose setting if provided
    if (config.frameRenderCache?.verbose !== undefined) {
      this.setCacheVerbose(config.frameRenderCache.verbose);
    }
    
    // Get focused stream for rendering
    const focusedStream = config.renderContext?.focusedStream;
    
    // Render each frame using centralized state retrieval (Layer 1) and render caching (Layer 2)
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const isCacheable = cacheEnabled && i < cacheableUntil;
      
      // TRY LAYER 2 CACHE FIRST (render cache)
      if (isCacheable) {
        const cachedChunks = this.getCachedChunksForFrame(frame.sequence, renderContext);
        if (cachedChunks) {
          // Cache hit! Use cached chunks
          allChunks.push(...cachedChunks);
          
          // Build frameRendering from cached chunks
          const content = cachedChunks.map(c => c.content).join('');
          const tokens = cachedChunks.reduce((sum, c) => sum + c.tokens, 0);
          const facetIds = Array.from(new Set(cachedChunks.flatMap(c => c.facetIds || [])));
          
          frameRenderings.push({
            frameSequence: frame.sequence,
            content,
            tokens,
            facetIds
          });
          
          totalTokens += tokens;
          continue;  // Skip rendering - used cache
        }
      }
      
      // LAYER 2 MISS - Get state from Layer 1 (VEILStateManager)
      // This is cached and compression-aware
      const snapshot = veilStateManager.getStateAtSequence(frame.sequence, compression);
      const replayedState = snapshot.facets;
      const removals = snapshot.removals;
      
      // Check if this frame is compressed
      if (compression?.shouldReplaceFrame(frame.sequence)) {
        const replacement = compression.getReplacement(frame.sequence);
        if (replacement !== null) {
          // Add replacement as a chunk with system role
          if (replacement) {
            const compressedChunk = createRenderedChunk(
              replacement,
              this.estimateTokens(replacement),
              {
                chunkType: 'compressed',
                role: 'system',
                metadata: { frameSequence: frame.sequence }
              }
            );
            allChunks.push(compressedChunk);
            totalTokens += compressedChunk.tokens;
          }
          continue;
        }
      }
      
      const source = this.getFrameSource(frame);

      // Determine render mode based on frame's stream vs focused stream
      const frameStream = frame.activeStream?.streamId;
      const renderMode = (!focusedStream || !frameStream || frameStream === focusedStream)
        ? 'focused'
        : 'unfocused';

      // Render chunks
      const chunks = this.renderFrameAsChunks(frame, source, replayedState, removals, renderMode);
      
      // Ensure all chunks have roles (fallback if not set)
      for (const chunk of chunks) {
        if (!chunk.role) {
          chunk.role = this.determineChunkRole(chunk, frame, config);
        }
        if (!chunk.metadata) {
          chunk.metadata = {};
        }
        chunk.metadata.frameSequence = frame.sequence;
      }
      
      // CACHE CHUNKS IN LAYER 2 if applicable
      if (isCacheable && chunks.length > 0) {
        this.cacheChunks(chunks, frame.sequence, renderContext);
      }
      
      // Build content and tokens for frameRendering
      const content = chunks.map(c => c.content).join('');
      const tokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
      const facetIds = Array.from(new Set(chunks.flatMap(c => c.facetIds || [])));
      
      // Trace each frame rendering
      tracer?.record({
        id: `${traceId}-frame-${frame.sequence}`,
        timestamp: Date.now(),
        level: 'debug',
        category: TraceCategory.HUD_RENDER,
        component: 'FrameTrackingHUD',
        operation: 'renderFrame',
        data: {
          frameSequence: frame.sequence,
          frameSource: source,
          operationCount: frame.deltas.length,
          deltas: frame.deltas.map(op => op.type),
          chunkCount: chunks.length,
          contentLength: content.length,
          contentPreview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
          tokens,
          facetIds,
          isEmpty: !content.trim()
        },
        parentId: traceId
      });
      
      frameRenderings.push({
        frameSequence: frame.sequence,
        content,
        tokens,
        facetIds
      });
      
      // Add chunks to collection
      allChunks.push(...chunks);
      
      // Only count non-empty content for token budget
      if (content.trim()) {
        totalTokens += tokens;
      }
    }
    
    // Check if we exceeded token budget (but don't drop frames)
    if (config.maxTokens && totalTokens > config.maxTokens) {
      console.warn(`[HUD] Token budget exceeded: ${totalTokens} > ${config.maxTokens}.`);
      console.warn(`[HUD] Including all ${frames.length} frames to preserve conversation coherence.`);
      console.warn(`[HUD] Consider increasing contextTokenBudget in AgentConfig.`);
    }

    // Render ambient facets from current state (BEFORE converting to messages)
    // Ambient facets are rendered from current state and respect scope visibility
    const ambientFacets = this.getAmbientFacets(currentFacets);
    console.log(`[HUD] Rendering ${ambientFacets.length} ambient facets from current state`);

    for (const [id, facet] of ambientFacets) {
      const rendered = this.renderFacet(facet);
      if (rendered) {
        // Debug: log tool-instruction facets being rendered
        if ((facet as any).displayName === 'tool-instruction') {
          console.log(`[HUD] Rendering tool-instruction ambient facet: ${id}`);
        }
        // Add ambient facets - determineFacetRole will classify as system (rendered at top)
        allChunks.push(createRenderedChunk(
          rendered + '\n',
          this.estimateTokens(rendered),
          {
            facetIds: [id],
            chunkType: facet.type,
            role: this.determineFacetRole(facet),
            metadata: { frameSequence: -1 } // No specific frame
          }
        ));
      }
    }

    // Build messages from chunks (NEW: facet-level rendering)
    const { messages, frameToMessageIndex } = this.chunksToMessages(
      allChunks,
      config,
      cacheableUntil  // Pass CBD boundary for cache marker placement
    );
    
    // Calculate total tokens from messages
    totalTokens = messages.reduce((sum, msg) => sum + this.estimateTokens(msg.content), 0);
    
    return {
      context: {
        messages,
        metadata: {
          totalTokens,
          renderedFrames: frameRenderings,
          frameToMessageIndex
        }
      },
      frameRenderings
    };
  }
  
  /**
   * Render agent frame as chunks
   */
  private renderAgentFrameAsChunks(frame: Frame): RenderedChunk[] {
    const chunks: RenderedChunk[] = [];
    const contentParts: Array<{ content: string; facetId: string; type: string; facet: Facet }> = [];

    // Collect content from facets
    for (const operation of frame.deltas) {
      if (operation.type === 'addFacet') {
        const facet = operation.facet;
        if (!facet) continue;
        
        let content = '';
        
        switch (facet.type) {
          case 'speech':
            if (hasContentAspect(facet)) {
              content = facet.content;
            }
            break;

          case 'action':
            if (hasStateAspect(facet)) {
              const { toolName, parameters } = facet.state as {
                toolName?: string;
                parameters?: Record<string, unknown>;
              };
              if (toolName) {
                content = this.renderToolCall(toolName, parameters ?? {});
              }
            }
            break;

          case 'thought':
            if (hasContentAspect(facet)) {
              content = `<thought>${facet.content}</thought>`;
          }
              break;

          case 'action-result': {
            // ActionResultFacet has fields at top level, not in state
            const actionResultFacet = facet as {
              actionId?: string;
              success?: boolean;
              result?: unknown;
              error?: string;
              message?: string;
              alias?: string;
            };
            content = this.renderToolResult(
              actionResultFacet.actionId || facet.id,
              actionResultFacet.success ?? false,
              actionResultFacet.result,
              actionResultFacet.error,
              actionResultFacet.message,
              actionResultFacet.alias
            );
            break;
          }
            }

        content = stripTurnMarkers(content);

        if (content) {
          contentParts.push({ content, facetId: facet.id, type: facet.type, facet });
        }
      }
    }

    // Only add turn markers if there's content
    if (contentParts.length > 0) {
      // Opening turn marker
      chunks.push(createRenderedChunk(
        '<my_turn>\n\n',
        this.estimateTokens('<my_turn>\n\n'),
        { 
          chunkType: 'turn-marker',
          role: 'assistant',
          metadata: { frameSequence: frame.sequence }
        }
      ));
      
      // Content chunks
      for (let i = 0; i < contentParts.length; i++) {
        const part = contentParts[i];
        const separator = i < contentParts.length - 1 ? '\n\n' : '';
        const role = this.determineFacetRole(part.facet);
        chunks.push(createRenderedChunk(
          part.content + separator,
          this.estimateTokens(part.content),
          { 
            facetIds: [part.facetId], 
            chunkType: part.type,
            role: role,
            metadata: { frameSequence: frame.sequence }
          }
        ));
      }
      
      // Closing turn marker
      chunks.push(createRenderedChunk(
        '\n\n</my_turn>',
        this.estimateTokens('\n\n</my_turn>'),
        { 
          chunkType: 'turn-marker',
          role: 'assistant',
          metadata: { frameSequence: frame.sequence }
        }
      ));
    }

    return chunks;
  }
  
  /**
   * Legacy wrapper - returns concatenated string
   */
  private renderAgentFrame(frame: Frame): string {
    const chunks = this.renderAgentFrameAsChunks(frame);
    return chunks.map(c => c.content).join('');
  }

  private getFrameSource(frame: Frame): 'user' | 'agent' | 'system' {
    // Domain-agnostic frame classification based on facet properties
    
    // Check for agent-generated facets (top-level facets with agentId)
    const hasAgentFacet = frame.deltas?.some(delta => {
      if (delta.type === 'addFacet' && delta.facet) {
        // Top-level facets with agentId indicate agent turn
        return !!(delta.facet as any).agentId;
      }
      return false;
    });
    
    if (hasAgentFacet) {
      return 'agent';
    }
    
    // Check for user input (facets with speech children that lack agentId)
    // Search recursively since speech may be nested (e.g., history → message → speech)
    const findUserSpeechRecursive = (node: any): boolean => {
      if (!node) return false;
      if ((node.type === 'speech' || node.type === 'thought') && !node.agentId) return true;
      if (Array.isArray(node.children)) {
        return node.children.some((child: any) => findUserSpeechRecursive(child));
      }
      return false;
    };

    const hasUserInput = frame.deltas?.some(delta => {
      if (delta.type === 'addFacet' && delta.facet) {
        return findUserSpeechRecursive(delta.facet);
      }
      return false;
    });
    
    if (hasUserInput) {
      return 'user';
    }

    // Default to user (system role should not be used)
    // Everything that isn't explicitly from an agent is user input/context
    return 'user';
  }

  /**
   * Determine LLM message role from facet structure (domain-agnostic)
   * 
   * Uses facet structure and metadata to classify, NOT source domain.
   * This allows the system to work with any axon (Discord, Slack, Email, etc.)
   * 
   * @param facet - The facet to classify
   * @param currentAgentId - ID of current agent (for multi-agent perspective)
   * @returns Role for this facet's content
   */
  private determineFacetRole(facet: Facet, currentAgentId?: string): 'user' | 'assistant' | 'system' {
    // ===== LEVEL 1: Agent-Generated Content =====
    // Any facet with agentId is agent content
    const facetAgentId = (facet as any).agentId;
    if (facetAgentId) {
      // Multi-agent: Only current agent is 'assistant', others are 'user'
      if (currentAgentId) {
        return facetAgentId === currentAgentId ? 'assistant' : 'user';
      }
      // Single agent: All agent content is 'assistant'
      return 'assistant';
    }
    
    // ===== LEVEL 2: Structural/Infrastructure Facets =====
    // Facets that appear at conversation start (before frames) can be system
    const systemPrefixTypes = [
      'ambient',            // Tool instructions, rendered at top
      'element-tree',
      'rendered-context',
      'agent-lifecycle',
      'action-definition',  // Action definitions at top
    ];

    if (systemPrefixTypes.includes(facet.type)) {
      return 'system';
    }

    // Mid-conversation facets must be 'user' to avoid breaking LLM API
    // (system messages only allowed at start of conversation)
    const userContextTypes = [
      'state',              // Tool results, component state (in frames)
      'agent-activation',   // Activation triggers (in frames)
      'component-state',    // Component status changes (in frames)
      'action-result',      // Tool/script execution results (feedback to agent)
    ];

    if (userContextTypes.includes(facet.type)) {
      return 'user';
    }
    
    // ===== LEVEL 3: Conversational Content (Domain-Agnostic) =====
    // Check if this is conversational based on structure
    
    // Direct speech/thought without agentId = user input
    if (facet.type === 'speech' || facet.type === 'thought') {
      // No agentId (already handled above), so this is user input
      return 'user';
    }
    
    // Container facets with speech children = conversational
    // Search recursively since speech may be nested (e.g., history → message → speech)
    const findSpeechRecursive = (node: any): any => {
      if (!node) return null;
      if (node.type === 'speech' || node.type === 'thought') return node;
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          const found = findSpeechRecursive(child);
          if (found) return found;
        }
      }
      return null;
    };

    const speechChild = findSpeechRecursive(facet);
    // Don't match if the facet itself is speech (already handled above)
    if (speechChild && speechChild !== facet) {
      // Has speech - check if from agent
      if (speechChild.agentId) {
        // Agent's speech (check multi-agent)
        return currentAgentId && speechChild.agentId !== currentAgentId
          ? 'user'      // Other agent
          : 'assistant'; // Current agent
      }
      // Speech without agentId = user input
      return 'user';
    }
    
    // ===== LEVEL 4: Events - Distinguish System vs User =====
    if (facet.type === 'event') {
      const eventType = facet.state?.eventType;
      
      // Infrastructure events (connections, joins, mounts, etc.)
      if (eventType && (
        eventType.includes('connected') ||
        eventType.includes('joined') ||
        eventType.includes('left') ||
        eventType.includes('mounted') ||
        eventType.includes('component-') ||
        eventType.includes('element-') ||
        eventType.includes('sync') ||
        eventType.includes('edit')
      )) {
        return 'system';
      }
      
      // Events with conversational children were already handled above
      // Events without children or speech = system infrastructure
      return 'system';
    }
    
    // ===== LEVEL 5: Actions/Tool Calls =====
    if (facet.type === 'action') {
      // Actions are agent-initiated (even if agentId not explicitly set)
      return 'assistant';
    }
    
    // ===== LEVEL 6: Agent-Specific Facets =====
    if (facet.type === 'agent-activation') {
      // Activation requests are system coordination
      return 'system';
    }
    
    // ===== FALLBACK =====
    // Unknown facets default to system (safe, non-conversational)
    return 'system';
  }

  /**
   * Render frame content as chunks with facet attribution
   * 
   * This is the single source of truth for frame rendering.
   * Returns chunks that can be used for both regular rendering
   * and snapshot capture.
   */
  private renderFrameAsChunks(
    frame: Frame,
    source: 'user' | 'agent' | 'system',
    replayedState: Map<string, Facet>,
    removals?: Map<string, 'hide' | 'delete'>,
    renderMode: 'focused' | 'unfocused' = 'focused'
  ): RenderedChunk[] {
    if (source === 'agent') {
      // Agent frames always rendered in focused mode (their own speech)
      return this.renderAgentFrameAsChunks(frame);
    }

    return this.renderEnvironmentFrameAsChunks(frame, replayedState, removals, renderMode);
  }
  
  /**
   * Legacy wrapper - returns concatenated string
   * Used by existing code during transition
   */
  private renderFrameContent(
    frame: Frame,
    source: 'user' | 'agent' | 'system',
    replayedState: Map<string, Facet>,
    removals?: Map<string, 'hide' | 'delete'>,
    focusedStream?: string
  ): { content: string; facetIds: string[] } {
    // Determine render mode based on frame's stream vs focused stream
    const frameStream = frame.activeStream?.streamId;
    const renderMode = (!focusedStream || !frameStream || frameStream === focusedStream)
      ? 'focused'
      : 'unfocused';
    
    const chunks = this.renderFrameAsChunks(frame, source, replayedState, removals, renderMode);
    const content = chunks.map(c => c.content).join('');
    const facetIds = Array.from(new Set(
      chunks.flatMap(c => c.facetIds || [])
    ));
    
    return { content, facetIds };
  }

  /**
   * Render environment frame as chunks
   */
  private renderEnvironmentFrameAsChunks(
    frame: Frame,
    replayedState: Map<string, Facet>,
    removals?: Map<string, 'hide' | 'delete'>,
    renderMode: 'focused' | 'unfocused' = 'focused'
  ): RenderedChunk[] {
    const chunks: RenderedChunk[] = [];
    const renderedStates = new Map<string, { 
      content: string; 
      facetId: string; 
      type: string; 
      facet: Facet;
      metadata?: any;
    }>();
    
    // HUD just renders facets - no concept of "history dump"
    // If a domain wants wrapping, encode it in the facet's displayName or structure

    // First pass: process state changes
    for (const operation of frame.deltas) {
      switch (operation.type) {
        case 'addFacet': {
          const facet = operation.facet;
          if (!facet || removals?.has(facet.id)) break;

          if (facet.type === 'state') {
            // Check scope visibility before rendering
            if (this.isFacetVisible(facet, replayedState)) {
              const rendered = this.renderFacet(facet, renderMode);
              if (rendered) {
                // Check for attachments
                const attachments = (facet.state?.metadata as any)?.attachments || (facet.state as any)?.attachments;
                
                renderedStates.set(facet.id, {
                  content: rendered,
                  facetId: facet.id,
                  type: facet.type,
                  facet: facet,
                  metadata: { attachments }
                });
              }
            }
          }
          replayedState.set(facet.id, facet);
          break;
        }

        case 'rewriteFacet': {
          if (removals?.get(operation.id) === 'delete') break;

          const currentFacet = replayedState.get(operation.id);
          if (!currentFacet) break;

          const updatedFacet = this.mergeFacetChanges(currentFacet, operation.changes);

          // Check scope visibility before rendering
          if (this.isFacetVisible(updatedFacet, replayedState)) {
            const rendered = this.renderFacet(updatedFacet, renderMode);
            if (rendered) {
              // Check for attachments
              const attachments = (updatedFacet.state?.metadata as any)?.attachments || (updatedFacet.state as any)?.attachments;

              renderedStates.set(operation.id, {
                content: rendered,
                facetId: operation.id,
                type: updatedFacet.type,
                facet: updatedFacet,
                metadata: { attachments }
              });
            }
          }
          replayedState.set(operation.id, updatedFacet);
            break;
          }
            
        case 'removeFacet':
          break;
      }
    }

    // Second pass: render in order, creating chunks
    for (const operation of frame.deltas) {
      switch (operation.type) {
        case 'addFacet': {
          const facet = operation.facet;
          if (!facet || removals?.has(facet.id)) break;
          
          // Use pre-rendered state if available
          if (renderedStates.has(facet.id)) {
            const { content, facetId, type, facet: stateFacet, metadata } = renderedStates.get(facet.id)!;
            const role = this.determineFacetRole(stateFacet);
            chunks.push(createRenderedChunk(
              content + '\n',
              this.estimateTokens(content),
              { 
                facetIds: [facetId], 
                chunkType: type,
                role: role,
                metadata: { 
                  frameSequence: frame.sequence,
                  attachments: metadata?.attachments
                }
              }
            ));
            renderedStates.delete(facet.id);
          break;
          }

          // Skip ambient facets - they're rendered separately from current state
          // This prevents duplicates from accumulating in frame history
          if (facet.type === 'ambient') {
            break;
          }

          // Check scope visibility before rendering
          if (!this.isFacetVisible(facet, replayedState)) {
            break;
          }

          // Render directly
          const rendered = this.renderFacet(facet, renderMode);
          if (rendered) {
            const role = this.determineFacetRole(facet);
            
            // Check for attachments in facet state (nested metadata) or top-level metadata
            const attachments = (facet.state?.metadata as any)?.attachments || (facet.state as any)?.attachments;

            chunks.push(createRenderedChunk(
              rendered + '\n',
              this.estimateTokens(rendered),
              {
                facetIds: [facet.id],
                chunkType: facet.type,
                role: role,
                metadata: { 
                  frameSequence: frame.sequence,
                  attachments // Propagate attachments
                }
              }
            ));
          }
            break;
          }
          
        case 'rewriteFacet': {
          if (removals?.has(operation.id)) break;
          
          if (renderedStates.has(operation.id)) {
            const { content, facetId, type, facet: stateFacet, metadata } = renderedStates.get(operation.id)!;
            const role = this.determineFacetRole(stateFacet);
            chunks.push(createRenderedChunk(
              content + '\n',
              this.estimateTokens(content),
              { 
                facetIds: [facetId], 
                chunkType: type,
                role: role,
                metadata: { 
                  frameSequence: frame.sequence,
                  attachments: metadata?.attachments 
                }
              }
            ));
            renderedStates.delete(operation.id);
          }
          break;
        }

        case 'removeFacet': {
          renderedStates.delete(operation.id);
          if (removals) {
            removals.set(operation.id, 'delete');
            const facet = replayedState.get(operation.id);
            if (facet && Array.isArray((facet as any)?.children)) {
              for (const child of (facet as any).children as Facet[]) {
                removals.set(child.id, 'delete');
              }
            }
          }
          replayedState.delete(operation.id);
          break;
        }
      }
    }
    

    return chunks;
  }
  
  /**
   * Legacy wrapper - returns concatenated string
   */
  private renderEnvironmentFrame(
    frame: Frame,
    replayedState: Map<string, Facet>,
    removals?: Map<string, 'hide' | 'delete'>
  ): string {
    const chunks = this.renderEnvironmentFrameAsChunks(frame, replayedState, removals);
    return chunks.map(c => c.content).join('');
  }
  
  /**
   * OLD IMPLEMENTATION - REPLACED BY renderEnvironmentFrameAsChunks
   * Keeping temporarily for reference
   */
  private renderEnvironmentFrameOld(
    frame: Frame,
    replayedState: Map<string, Facet>,
    removals?: Map<string, 'hide' | 'delete'>
  ): string {
    const parts: string[] = [];
    const renderedStates = new Map<string, string>();
    
    for (const operation of frame.deltas) {
      switch (operation.type) {
        case 'addFacet': {
          const facet = operation.facet;
          if (!facet) {
            console.error('[FrameTrackingHUD] Invalid addFacet operation - missing facet:', operation);
            break;
          }
          if (removals?.has(facet.id)) {
          break;
          }
          if (facet.type === 'state') {
            const rendered = this.renderFacet(facet);
            if (rendered) {
              renderedStates.set(facet.id, rendered);
            }
          }
          replayedState.set(facet.id, facet);
          break;
        }

        case 'rewriteFacet': {
          if (removals?.get(operation.id) === 'delete') {
            break;
          }

          const currentFacet = replayedState.get(operation.id);
          if (!currentFacet) {
          break;
          }

          const updatedFacet = this.mergeFacetChanges(currentFacet, operation.changes);
          const rendered = this.renderFacet(updatedFacet);
          if (rendered) {
            renderedStates.set(operation.id, rendered);
          }
          replayedState.set(operation.id, updatedFacet);
          break;
        }

        case 'removeFacet':
          break;
      }
    }

    for (const operation of frame.deltas) {
      switch (operation.type) {
        case 'addFacet': {
          const facet = operation.facet;
          if (!facet) {
            console.error('[FrameTrackingHUD] Invalid addFacet operation in second pass - missing facet:', operation);
          break;
      }
          if (removals?.has(facet.id)) {
            break;
          }

          if (renderedStates.has(facet.id)) {
            const finalRendering = renderedStates.get(facet.id);
            if (finalRendering) {
              parts.push(finalRendering);
            }
            renderedStates.delete(facet.id);
            break;
          }

          const rendered = this.renderFacet(facet);
          if (rendered) {
            parts.push(rendered);
          }
          break;
        }

        case 'rewriteFacet': {
          if (removals?.has(operation.id)) {
            break;
          }

          const finalRendering = renderedStates.get(operation.id);
          if (finalRendering) {
            parts.push(finalRendering);
            renderedStates.delete(operation.id);
          }
          break;
        }

        case 'removeFacet': {
          renderedStates.delete(operation.id);
          if (removals) {
            removals.set(operation.id, 'delete');
            const facet = replayedState.get(operation.id);
            if (facet && Array.isArray((facet as any)?.children)) {
              for (const child of (facet as any).children as Facet[]) {
                removals.set(child.id, 'delete');
              }
            }
          }
          replayedState.delete(operation.id);
          break;
        }
      }
    }

    return parts.join('\n');
  }
  
  /**
   * Check if a facet is visible based on active scopes
   */
  private isFacetVisible(facet: Facet, replayedState: Map<string, Facet>): boolean {
    // Get facet's scope requirements
    const facetScope = (facet as any).scope;

    // Facets with no scope attribute are always visible
    if (!facetScope || !Array.isArray(facetScope) || facetScope.length === 0) {
      return true;
    }

    // Debug logging for scoped facets
    const isToolInstruction = facet.type === 'ambient' && (facet as any).displayName === 'tool-instruction';
    if (isToolInstruction) {
      console.log(`[HUD.isFacetVisible] Checking tool-instruction facet ${facet.id}:`, {
        facetScope,
        replayedStateSize: replayedState.size
      });
    }

    // Check if at least one of the facet's required scopes is active
    for (const requiredScope of facetScope) {
      const scopeFacetId = `scope-${requiredScope}`;
      const scopeFacet = replayedState.get(scopeFacetId);

      if (isToolInstruction) {
        console.log(`[HUD.isFacetVisible]   Looking for scope facet ${scopeFacetId}:`, {
          found: !!scopeFacet,
          type: scopeFacet?.type,
          state: (scopeFacet as any)?.state
        });
      }

      if (scopeFacet && scopeFacet.type === 'scope-change') {
        const scopeState = (scopeFacet as any).state;
        if (scopeState && scopeState.active === true) {
          if (isToolInstruction) {
            console.log(`[HUD.isFacetVisible]   ✓ Scope is active, facet is VISIBLE`);
          }
          // At least one required scope is active
          return true;
        } else if (isToolInstruction) {
          console.log(`[HUD.isFacetVisible]   ✗ Scope exists but not active:`, scopeState);
        }
      } else if (isToolInstruction) {
        console.log(`[HUD.isFacetVisible]   ✗ Scope facet not found or wrong type`);
      }
    }

    if (isToolInstruction) {
      console.log(`[HUD.isFacetVisible]   Result: HIDDEN (no active scopes)`);
    }
    // None of the required scopes are active
    return false;
  }

  /**
   * Render facet in unfocused mode (structured with stream context)
   */
  private renderFacetUnfocused(facet: Facet): string | null {
    // Extract content from facet or children
    let content: string | null = null;
    
    // Try direct content first
    if (hasContentAspect(facet) && facet.content) {
      content = facet.content;
    }
    
    // Try children if no direct content
    if (!content) {
      const children = (facet as any).children;
      if (Array.isArray(children) && children.length > 0) {
        // Recursively render children and join
        const childContents: string[] = [];
        for (const child of children) {
          const childRendered = this.renderFacet(child, 'focused');  // Render children normally
          if (childRendered) {
            childContents.push(childRendered);
          }
        }
        if (childContents.length > 0) {
          content = childContents.join('\n');
        }
      }
    }
    
    if (!content) return null;
    
    const streamId = facet.streamId || 'unknown-stream';
    const facetType = facet.type;
    
    // Extract channel name from metadata if available for cleaner display
    let streamLabel = streamId;
    if (facet.state?.metadata?.channelName) {
      streamLabel = `#${facet.state.metadata.channelName}`;
    }
    
    // Wrap with event tag and stream attribute
    return `<event stream="${streamId}" type="${facetType}" label="${streamLabel}">${content}</event>`;
  }
  
  private renderFacet(facet: Facet, renderMode: 'focused' | 'unfocused' = 'focused'): string | null {
    const tracer = getGlobalTracer();
    
    const facetContent = hasContentAspect(facet) ? facet.content : undefined;
    const facetChildren = Array.isArray((facet as any)?.children)
      ? ((facet as any).children as Facet[])
      : [];

    // Special handling for action-result facets (have fields at top level, not content)
    if (facet.type === 'action-result') {
      const actionResultFacet = facet as {
        actionId?: string;
        success?: boolean;
        result?: unknown;
        error?: string;
        message?: string;
        alias?: string;
      };
      return this.renderToolResult(
        actionResultFacet.actionId || facet.id,
        actionResultFacet.success ?? false,
        actionResultFacet.result,
        actionResultFacet.error,
        actionResultFacet.message,
        actionResultFacet.alias
      );
    }

    // Skip facets with no content AND no children
    if (!facetContent && facetChildren.length === 0) {
      return null;
    }
    
    // NEW: For unfocused mode, use structured rendering
    // Do this BEFORE checking content/children so it handles all cases
    if (renderMode === 'unfocused') {
      return this.renderFacetUnfocused(facet);  // Handles children internally
    }
    
    // EXISTING: Focused mode rendering (clean colon format)
    const parts: string[] = [];
    
    // Trace facet rendering
    const facetTraceId = `facet-render-${facet.id}-${Date.now()}`;
    tracer?.record({
      id: facetTraceId,
      timestamp: Date.now(),
      level: 'trace',
      category: TraceCategory.HUD_RENDER,
      component: 'FrameTrackingHUD',
      operation: 'renderFacet',
      data: {
        id: facet.id,
        facetType: facet.type,
        displayName: (facet as any).displayName,
        hasContent: true, // We already checked hasContentAspect
        contentPreview: facetContent
          ? facetContent.substring(0, 100) + (facetContent.length > 100 ? '...' : '')
          : null,
        childCount: facetChildren.length,
        state: hasStateAspect(facet) ? facet.state : undefined
      }
    });
    
    // Use displayName as tag if available
    const displayName = (facet as any).displayName;
    if (typeof displayName === 'string' && displayName.length > 0) {
      const tag = this.sanitizeTagName(displayName);
      
      // Render the facet's own content
      if (facetContent) {
        parts.push(`<${tag}>${facetContent}</${tag}>`);
      }
      
      // Render child facets
      if (facetChildren.length > 0) {
        const childParts: string[] = [];
        for (const child of facetChildren) {
          const rendered = this.renderFacet(child);
          if (rendered) {
            childParts.push(rendered);
          }
        }
        if (childParts.length > 0) {
          // If facet has both content and children, wrap children
          if (facetContent) {
            parts.push(`<${tag}-children>`);
            parts.push(...childParts);
            parts.push(`</${tag}-children>`);
          } else {
            // If only children, include them in the main tag
            return `<${tag}>\n${childParts.join('\n')}\n</${tag}>`;
          }
        }
      }
      
      return parts.join('\n');
    }
    
    // No tag for facets without displayName
    if (facetContent) {
      // For speech facets, include speaker attribution
      if (facet.type === 'speech' && hasStateAspect(facet)) {
        const speaker = (facet.state as any).speaker;
        if (speaker) {
          parts.push(`${speaker}: ${facetContent}`);
        } else {
          parts.push(facetContent);
        }
      } else {
        parts.push(facetContent);
      }
    }
    
    // Still render children even without displayName
    if (facetChildren.length > 0) {
      for (const child of facetChildren) {
        const rendered = this.renderFacet(child);
        if (rendered) {
          parts.push(rendered);
        }
      }
    }
    
    return parts.length > 0 ? parts.join('\n') : null;
  }
  
  private renderToolCall(toolName: string, parameters: any): string {
    // Render as <action> to match what the agent writes
    const parts = [`<action name="${toolName}">`];

    for (const [key, value] of Object.entries(parameters)) {
      parts.push(`<parameter name="${key}">${this.escapeXml(String(value))}</parameter>`);
    }

    parts.push('</action>');
    return parts.join('\n');
  }

  private renderToolResult(actionId: string, success: boolean, result: unknown, error?: string, message?: string, alias?: string): string {
    // Render as <action_result> to pair with <action>
    // Include alias attribute if provided (for correlating results with actions)
    const aliasAttr = alias ? ` alias="${this.escapeXml(alias)}"` : '';
    const parts = [`<action_result action_id="${this.escapeXml(actionId)}"${aliasAttr} success="${success}">`];

    if (success) {
      if (result !== undefined) {
        // Render result - if it's an object, JSON stringify it
        const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
        parts.push(this.escapeXml(resultStr));
      } else if (message) {
        parts.push(this.escapeXml(message));
      }
    } else {
      // Error case
      if (error) {
        parts.push(`Error: ${this.escapeXml(error)}`);
      } else if (message) {
        parts.push(this.escapeXml(message));
      }
    }

    parts.push('</action_result>');
    return parts.join('\n');
  }

  private renderAction(action: any): string {
    // Render as the original @path syntax (e.g., @chat.general.say)
    const actionPath = action.path.join('.');
    
    if (action.parameters && Object.keys(action.parameters).length > 0) {
      const params = action.parameters;
      // Check if it's a simple single value parameter
      if (Object.keys(params).length === 1 && params.value !== undefined) {
        return `@${actionPath}("${params.value}")`;
      } else {
        // Multi-parameter, render as block
        const paramLines = Object.entries(params).map(([key, value]) => 
          `  ${key}: ${value}`
        ).join('\n');
        return `@${actionPath} {\n${paramLines}\n}`;
      }
    } else {
      // No parameters
      return `@${actionPath}`;
    }
  }
  
  private renderCurrentState(
    facets: Map<string, Facet>,
    config: HUDConfig
  ): string | null {
    const stateParts: string[] = [];
    
    // Render only state facets - ambient facets are handled separately with floating behavior
    for (const [id, facet] of facets) {
      if (facet.type === 'state') {
        const rendered = this.renderFacet(facet);
        if (rendered) stateParts.push(rendered);
      }
    }
    
    return stateParts.length > 0 ? stateParts.join('\n\n') : null;
  }
  
  /**
   * Convert chunks to LLM messages, preserving frame boundaries and grouping by role
   * 
   * @param chunks - Rendered chunks with roles
   * @param config - HUD configuration
   * @param cacheableUntil - Frame boundary for cache markers
   * @returns Messages array for LLM and chunk-to-message mapping
   */
  private chunksToMessages(
    chunks: RenderedChunk[],
    config: HUDConfig,
    cacheableUntil: number = 0
  ): { messages: RenderedContext['messages']; frameToMessageIndex: Map<number, number> } {
    const messages: RenderedContext['messages'] = [];
    const frameToMessageIndex = new Map<number, number>();
    
    const promptCachingEnabled = config.promptCaching?.enabled ?? false;
    
    // Group chunks by frame sequence
    const chunksByFrame = new Map<number, RenderedChunk[]>();
    for (const chunk of chunks) {
      const frameSeq = chunk.metadata?.frameSequence ?? 0;
      if (!chunksByFrame.has(frameSeq)) {
        chunksByFrame.set(frameSeq, []);
      }
      chunksByFrame.get(frameSeq)!.push(chunk);
    }
    
    // Sort frames by sequence
    const sortedFrameSeqs = Array.from(chunksByFrame.keys()).sort((a, b) => a - b);
    
    // Process each frame
    for (const frameSeq of sortedFrameSeqs) {
      const frameChunks = chunksByFrame.get(frameSeq)!;
      
      // Group chunks within frame by role
      let currentRole: 'user' | 'assistant' | 'system' | null = null;
      let currentContent: string[] = [];
      let currentAttachments: any[] = [];
      
      for (const chunk of frameChunks) {
        const role = chunk.role || 'system';
        
        // If role changes within frame, flush current message
        if (role !== currentRole && currentRole !== null && currentContent.length > 0) {
          const messageIndex = messages.length;
          frameToMessageIndex.set(frameSeq, messageIndex);
          
          const message: any = {
            role: currentRole,
            content: currentContent.join('\n\n'),
            sourceFrames: {
              from: frameSeq,
              to: frameSeq
            }
          };

          if (currentAttachments.length > 0) {
            if (!message.metadata) message.metadata = {};
            message.metadata.attachments = [...currentAttachments];
            currentAttachments = []; // Clear after attaching
          }

          messages.push(message);
          
          currentContent = [];
        }
        
        currentRole = role;
        if (chunk.content.trim()) {  // Skip empty chunks
          currentContent.push(chunk.content);
        }

        // Collect attachments
        if (chunk.metadata?.attachments) {
          if (Array.isArray(chunk.metadata.attachments)) {
            currentAttachments.push(...chunk.metadata.attachments);
          } else {
            currentAttachments.push(chunk.metadata.attachments);
          }
        }
      }
      
      // Flush last message for this frame
      if (currentContent.length > 0 && currentRole) {
        const messageIndex = messages.length;
        frameToMessageIndex.set(frameSeq, messageIndex);
        
        // Check if this frame should have cache marker
        const shouldCache = promptCachingEnabled && 
                            cacheableUntil > 0 && 
                            frameSeq === cacheableUntil - 1;
        
        const message: any = {
          role: currentRole,
          content: currentContent.join('\n\n'),
          sourceFrames: {
            from: frameSeq,
            to: frameSeq
          }
        };
        
        if (shouldCache) {
          message.metadata = {
            cacheControl: { type: 'ephemeral' as const }
          };
        }

        if (currentAttachments.length > 0) {
          if (!message.metadata) message.metadata = {};
          message.metadata.attachments = [...currentAttachments];
        }
        
        messages.push(message);
      }
    }
    
    // Apply format config for prefill
    // Build the prefill content: <my_turn>\n<thinking>\n if both enabled
    let prefillContent = '';
    
    // Start with assistant prefix if present (e.g., "<my_turn>\n")
    if (config.formatConfig?.assistant?.prefix) {
      prefillContent += config.formatConfig.assistant.prefix;
    }
    
    // Add thinking open tag INSIDE the turn if enabled
    // Result: <my_turn>\n<thinking>\n...reasoning...</thinking>\n...response...\n</my_turn>
    const thinkingConfig = config.formatConfig?.thinking;
    if (thinkingConfig?.enabled) {
      const thinkingOpenTag = thinkingConfig.openTag ?? '<thinking>\n';
      prefillContent += thinkingOpenTag;
    }
    
    // Apply the prefill if we have content
    if (prefillContent) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === 'assistant') {
        // Add prefill to existing assistant message
        lastMessage.content = prefillContent + lastMessage.content;
      } else {
        // Add new assistant message with prefill content
        messages.push({
          role: 'assistant',
          content: prefillContent
        });
      }
    }
    
    return { messages, frameToMessageIndex };
  }
  
  /**
   * Get cached chunks for a frame from render cache
   */
  private getCachedChunksForFrame(
    frameSequence: number,
    renderContext: RenderContext
  ): RenderedChunk[] | null {
    const cachedChunks = this.frameRenderCache.get(renderContext, frameSequence);
    
    if (!cachedChunks) {
      return null;
    }
    
    // Convert CachedChunk[] to RenderedChunk[]
    return cachedChunks.map(cached => ({
      content: cached.content,
      tokens: cached.tokens,
      facetIds: cached.facetIds,
      role: cached.role,
      metadata: { frameSequence: cached.frameSequence }
    }));
  }
  
  /**
   * Cache chunks for a frame in the render cache
   */
  private cacheChunks(
    chunks: RenderedChunk[],
    frameSequence: number,
    renderContext: RenderContext
  ): void {
    // Convert RenderedChunk[] to CachedChunk[]
    const cachedChunks: CachedChunk[] = chunks.map((chunk, index) => {
      const facetPart = chunk.facetIds?.join('-') || 'unknown';
      const chunkId = `${frameSequence}-${facetPart}-${index}`;
      
      return {
        chunkId,
        context: renderContext,
        content: chunk.content,
        role: chunk.role || 'system',
        tokens: chunk.tokens,
        facetIds: chunk.facetIds || [],
        frameSequence: frameSequence,
        cachedAt: Date.now()
      };
    });
    
    this.frameRenderCache.set(renderContext, frameSequence, cachedChunks);
  }
  
  /**
   * Determine chunk role as fallback when chunk doesn't have role set
   */
  private determineChunkRole(
    chunk: RenderedChunk,
    frame: Frame,
    config?: HUDConfig
  ): 'user' | 'assistant' | 'system' {
    // If chunk already has role, use it
    if (chunk.role) return chunk.role;
    
    // If chunk has facetIds, determine from first facet
    if (chunk.facetIds && chunk.facetIds.length > 0) {
      // Find facet in frame.deltas
      for (const delta of frame.deltas) {
        if (delta.type === 'addFacet' && delta.facet && delta.facet.id === chunk.facetIds[0]) {
          return this.determineFacetRole(delta.facet, config?.currentAgentId);
        }
      }
    }
    
    // Check chunkType as fallback
    if (chunk.chunkType === 'turn-marker') return 'assistant';
    if (chunk.chunkType === 'speech') return 'assistant';
    if (chunk.chunkType === 'event') return 'user';
    
    return 'system';
  }
  
  private buildFrameBasedMessages(
    frameContents: Array<{ type: 'user' | 'agent' | 'system' | 'compressed'; content: string; sequence: number }>,
    currentFacets: Map<string, Facet>,
    config: HUDConfig,
    cacheableUntil: number = 0  // CBD boundary for cache marker placement
  ): { messages: RenderedContext['messages']; frameToMessageIndex: Map<number, number> } {
    const messages: RenderedContext['messages'] = [];
    const frameToMessageIndex = new Map<number, number>();
    
    // Determine if prompt caching is enabled
    const promptCachingEnabled = config.promptCaching?.enabled ?? false;
    
    // Each frame becomes its own message
    for (const frame of frameContents) {
      let role: 'user' | 'assistant' | 'system';
      switch (frame.type) {
        case 'user':
          role = 'user';
          break;
        case 'agent':
          role = 'assistant';
          break;
        case 'system':
          role = 'system';
          break;
        default:
          role = 'assistant';
          break;
      }

      const messageIndex = messages.length;
      frameToMessageIndex.set(frame.sequence, messageIndex);
      
      // Determine if this message should have a cache marker
      // Place marker at CBD boundary (last cacheable frame)
      const shouldCache = promptCachingEnabled && 
                          cacheableUntil > 0 && 
                          frame.sequence === cacheableUntil - 1;
      
      // Build message with optional cache control
      const message: any = {
        role,
        content: frame.content,
        sourceFrames: {
          from: frame.sequence,
          to: frame.sequence
        }
      };
      
      if (shouldCache) {
        message.metadata = {
          cacheControl: {
            type: 'ephemeral' as const
          }
        };
      }
      
      messages.push(message);
    }
    
    // Add floating ambient and state content as system context
    // Ambient facets are rendered from current state and respect scope visibility
    const ambientFacets = this.getAmbientFacets(currentFacets);
    const ambientContent: string[] = [];

    for (const [id, facet] of ambientFacets) {
      const rendered = this.renderFacet(facet);
      if (rendered) {
        // Debug: log tool-instruction facets being rendered
        if ((facet as any).displayName === 'tool-instruction') {
          console.log(`[HUD] Rendering tool-instruction ambient facet: ${id}`);
        }
        ambientContent.push(rendered);
      }
    }

    // Don't add state content here - states are only rendered in frames where they're added or changed
    const contextParts = [...ambientContent];
    
    // Add pending activations info if present
    if (config.metadata?.pendingActivations) {
      const { count, sources } = config.metadata.pendingActivations;
      const pendingInfo = `<pending_activations>\nThere are ${count} pending activation(s) from: ${sources.join(', ')}\n</pending_activations>`;
      contextParts.push(pendingInfo);
    }
    
    if (contextParts.length > 0) {
      // Add context to the last user message or create a new one
      const contextContent = contextParts.join('\n\n');
      const lastMessage = messages[messages.length - 1];
      
      if (lastMessage && lastMessage.role === 'user') {
        // Append to last user message
        lastMessage.content = `${lastMessage.content}\n\n${contextContent}`;
      } else {
        // Create a new user message with context
        messages.push({
          role: 'user',
          content: contextContent
        });
      }
    }
    
    // Apply format config for prefill
    // Build the prefill content: <my_turn>\n<thinking>\n if both enabled
    let prefillContent = '';
    
    // Start with assistant prefix if present (e.g., "<my_turn>\n")
    if (config.formatConfig?.assistant?.prefix) {
      prefillContent += config.formatConfig.assistant.prefix;
    }
    
    // Add thinking open tag INSIDE the turn if enabled
    // Result: <my_turn>\n<thinking>\n...reasoning...</thinking>\n...response...\n</my_turn>
    const thinkingConfig = config.formatConfig?.thinking;
    if (thinkingConfig?.enabled) {
      const thinkingOpenTag = thinkingConfig.openTag ?? '<thinking>\n';
      prefillContent += thinkingOpenTag;
    }
    
    // Apply the prefill if we have content
    if (prefillContent) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === 'assistant') {
        // Add prefill to existing assistant message
        lastMessage.content = prefillContent + lastMessage.content;
      } else {
        // Add new assistant message with prefill content
        messages.push({
          role: 'assistant',
          content: prefillContent
        });
      }
    }
    
    return { messages, frameToMessageIndex };
  }
  
  private getAmbientFacets(facets: Map<string, Facet>): Array<[string, Facet]> {
    const ambient: Array<[string, Facet]> = [];
    let ambientCount = 0;
    let visibleCount = 0;

    for (const [id, facet] of facets) {
      if (facet.type === 'ambient') {
        ambientCount++;
        // Check scope visibility for ambient facets
        const isVisible = this.isFacetVisible(facet, facets);
        console.log(`[HUD.getAmbientFacets] Found ambient facet ${id}:`, {
          displayName: (facet as any).displayName,
          hasContent: !!(facet as any).content,
          scope: (facet as any).scope,
          isVisible
        });
        if (isVisible) {
          visibleCount++;
          ambient.push([id, facet]);
        }
      }
    }

    console.log(`[HUD.getAmbientFacets] Total facets: ${facets.size}, ambient: ${ambientCount}, visible: ${visibleCount}`);
    return ambient;
  }
  
  private insertFloatingAmbient(
    renderedParts: string[],
    ambientFacets: Array<[string, Facet]>,
    preferredDepth: number = 5
  ): string[] {
    if (ambientFacets.length === 0 || renderedParts.length === 0) {
      return renderedParts;
    }
    
    // Calculate insertion position for floating ambient
    const insertPosition = Math.max(0, renderedParts.length - preferredDepth);
    
    // Create a new array with ambient facets inserted
    const result = [...renderedParts];
    const ambientContent: string[] = [];
    
    for (const [id, facet] of ambientFacets) {
      const rendered = this.renderFacet(facet);
      if (rendered) ambientContent.push(rendered);
    }
    
    if (ambientContent.length > 0) {
      result.splice(insertPosition, 0, ambientContent.join('\n\n'));
    }
    
    return result;
  }
  
  private extractFacetIds(frame: Frame): string[] {
    const ids: string[] = [];
    
    for (const op of frame.deltas) {
      if (op.type === 'addFacet') {
        ids.push(op.facet.id);
      } else if (op.type === 'rewriteFacet' || op.type === 'removeFacet') {
        ids.push(op.id);
      }
    }
    
    return ids;
  }
  
  private sanitizeTagName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  }
  

  private cloneFacet(facet: Facet): Facet {
    const cloned = { ...facet } as Facet;

    if (hasStateAspect(facet)) {
      (cloned as Facet & { state: Record<string, unknown> }).state = {
        ...facet.state
      };
    }

    if (Array.isArray((facet as any)?.children)) {
      (cloned as any).children = ((facet as any).children as Facet[]).map(child =>
        this.cloneFacet(child)
      );
    }

    return cloned;
  }

  private mergeFacetChanges(existing: Facet, changes: Partial<Facet>): Facet {
    const merged = { ...existing, ...changes } as Facet;
    const changeRecord = changes as Record<string, unknown>;

    if ('state' in changeRecord && changeRecord.state && typeof changeRecord.state === 'object') {
      const newState = changeRecord.state as Record<string, unknown>;
      if (hasStateAspect(existing)) {
        (merged as Facet & { state: Record<string, unknown> }).state = {
          ...existing.state,
          ...newState
        };
      } else {
        (merged as any).state = { ...newState };
      }
    }

    if ('content' in changeRecord && typeof changeRecord.content === 'string') {
      (merged as any).content = changeRecord.content;
    }

    if ('children' in changeRecord && Array.isArray(changeRecord.children)) {
      (merged as any).children = changeRecord.children;
    }

    if ('displayName' in changeRecord) {
      (merged as any).displayName = changeRecord.displayName;
    }

    return merged;
  }
  
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  
  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }
  
  /**
   * Render a single frame and capture as a chunked snapshot
   * 
   * This uses the shared rendering path (renderFrameAsChunks) to ensure
   * snapshots match actual rendering exactly.
   * 
   * @param frame - The frame to render
   * @param currentFacets - Current VEIL state facets
   * @param replayedState - Optional replayed state (for context)
   * @returns Snapshot with chunked content and facet attribution
   */
  captureFrameSnapshot(
    frame: Frame,
    currentFacets: Map<string, Facet>,
    replayedState?: Map<string, Facet>
  ): FrameRenderedSnapshot {
    const source = this.getFrameSource(frame);
    const stateToUse = replayedState || new Map(currentFacets);
    
    // Use the shared rendering path - single source of truth!
    const chunks = this.renderFrameAsChunks(frame, source, stateToUse);
    
    // Build snapshot
    const totalContent = chunks.map(c => c.content).join('');
    const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
    
    return {
      chunks,
      totalContent,
      totalTokens,
      capturedAt: Date.now()
    };
  }
  
  parseCompletion(completion: string): {
    operations: OutgoingVEILOperation[];
    hasMoreToSay: boolean;
  } {
    // TODO: Implement parsing
    return {
      operations: [],
      hasMoreToSay: false
    };
  }
  
  needsCompression(frames: Frame[], config: HUDConfig): boolean {
    // Simple check based on frame count or estimated tokens
    return frames.length > 50;
  }
  
  getFormat(): string {
    return 'xml';
  }
}
