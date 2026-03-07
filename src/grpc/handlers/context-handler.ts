/**
 * Context Handler for gRPC GetContext requests
 * Renders context for agents based on VEIL state
 */

import { Space } from '../../spaces/space.js';
import { VEILStateManager } from '../../veil/veil-state.js';
import type { Facet, StreamRef } from '../../veil/types.js';

/**
 * Context request from client
 */
export interface ContextRequest {
  agentId: string;
  agentName?: string;
  streamId: string;
  maxFrames: number;
  maxTokens: number;
  facetTypes: string[];
}

/**
 * Rendered context result
 */
export interface ContextResult {
  agentId: string;
  streamId: string;
  contextJson: Uint8Array;
  tokenCount: number;
  frameCount: number;
  compressionRatio: number;
}

/**
 * Simple token estimator (characters / 4 as rough approximation)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Handles context rendering for gRPC clients
 */
export class ContextHandler {
  private space: Space;
  private veilState: VEILStateManager;

  constructor(space: Space, veilState: VEILStateManager) {
    this.space = space;
    this.veilState = veilState;
  }

  /**
   * Handle a GetContext request
   */
  async handleGetContext(request: ContextRequest): Promise<ContextResult> {
    const { agentId, agentName, streamId, maxFrames, maxTokens, facetTypes } = request;

    // Use direct readonly references (zero-copy) instead of getState() which copies everything
    const frameHistory = this.veilState.getFrameHistory();
    const allFacets = this.veilState.getFacets();

    // Look up stream parentage for hierarchy-aware filtering
    const parentage = streamId ? this.veilState.getStreamParentage(streamId) : null;

    // Debug: stream hierarchy resolution
    if (streamId) {
      const registeredStreams = this.veilState.getStreams();
      const streamEntry = registeredStreams.get(streamId);
      console.log(`[ContextHandler] Stream ${streamId}: registered=${!!streamEntry}, parentage=${parentage ? `parentId=${parentage.parentId} fork@${parentage.forkSequence}` : 'none'}, totalRegisteredStreams=${registeredStreams.size}`);
    }

    // Reverse-iterate to collect up to maxFrames matching frames, with early exit
    let frames: any[];
    if (maxFrames > 0 || streamId) {
      const collected: any[] = [];
      let directCount = 0;
      let parentCount = 0;
      let ambientCount = 0;
      const limit = maxFrames > 0 ? maxFrames : frameHistory.length;
      for (let i = frameHistory.length - 1; i >= 0 && collected.length < limit; i--) {
        const f = frameHistory[i];
        if (streamId && f.activeStream) {
          const fStreamId = f.activeStream.streamId;
          if (fStreamId === streamId) {
            directCount++;
            // Direct match — always include
          } else if (parentage && fStreamId === parentage.parentId && f.sequence <= parentage.forkSequence) {
            parentCount++;
            // Parent stream frame before fork point — include (inherited context)
          } else {
            continue; // Skip — different stream and not an inherited parent frame
          }
        } else if (!f.activeStream) {
          ambientCount++;
        }
        // Frames with no activeStream are ambient — always included
        collected.push(f);
      }
      collected.reverse(); // Restore chronological order
      frames = collected;

      if (parentage) {
        console.log(`[ContextHandler] Frame collection: direct=${directCount} parent=${parentCount} ambient=${ambientCount} total=${collected.length} (scanned ${Math.min(frameHistory.length, limit + (frameHistory.length - collected.length))} of ${frameHistory.length})`);
      }
    } else {
      frames = frameHistory as any[];
    }

    // Build context object
    const context = this.buildContext(frames, agentId, streamId, facetTypes, allFacets as Map<string, Facet>, agentName, parentage);

    // Serialize to JSON
    const contextStr = JSON.stringify(context);
    const contextJson = new TextEncoder().encode(contextStr);

    // Estimate tokens
    const tokenCount = estimateTokens(contextStr);

    // Calculate compression ratio (if we had original size)
    const compressionRatio = 1.0; // No compression for now

    // Trim if over token limit
    let finalContext = context;
    let finalTokenCount = tokenCount;

    if (maxTokens > 0 && tokenCount > maxTokens) {
      finalContext = this.trimContext(context, maxTokens);
      const trimmedStr = JSON.stringify(finalContext);
      finalTokenCount = estimateTokens(trimmedStr);
    }

    const finalJson = new TextEncoder().encode(JSON.stringify(finalContext));

    return {
      agentId,
      streamId,
      contextJson: finalJson,
      tokenCount: finalTokenCount,
      frameCount: frames.length,
      compressionRatio
    };
  }

  /**
   * Build context from frames and facets
   */
  private buildContext(
    frames: any[],
    agentId: string,
    streamId: string,
    facetTypes: string[],
    allFacets: Map<string, Facet>,
    agentName?: string,
    parentage?: { parentId: string; forkSequence: number } | null
  ): any {
    const context: any = {
      agent: {
        id: agentId,
        stream: streamId
      },
      conversation: [],
      state: {},
      metadata: {
        frameCount: frames.length,
        timestamp: new Date().toISOString()
      }
    };

    // Track which facet IDs we've already added (to avoid duplicates)
    const addedFacetIds = new Set<string>();

    // Helper to add a facet to conversation
    // fromFilteredFrame: true when called from the frame-delta loop (frames already
    // hierarchy-filtered), so we skip the stream check — parent facets are intentional.
    const addToConversation = (facet: any, timestamp?: string, fromFilteredFrame?: boolean) => {
      if (addedFacetIds.has(facet.id)) return;
      addedFacetIds.add(facet.id);

      // Filter by type if specified
      if (facetTypes.length > 0 && !facetTypes.includes(facet.type)) {
        return;
      }

      // Filter by stream — skip for facets from hierarchy-filtered frames
      // (parent stream facets are included intentionally via frame-level filtering)
      if (!fromFilteredFrame && streamId && facet.streamId && facet.streamId !== streamId) {
        // Allow parent stream facets through (hierarchy inheritance)
        if (!parentage || facet.streamId !== parentage.parentId) {
          return;
        }
      }

      // Add to conversation based on type
      if (facet.type === 'event') {
        const eventState = facet.state || {};
        const metadata: any = {
          eventType: eventState.eventType,
          source: eventState.source
        };

        // Include attachments for image processing
        if (eventState.attachments && Array.isArray(eventState.attachments) && eventState.attachments.length > 0) {
          metadata.attachments = eventState.attachments;
        }

        context.conversation.push({
          role: 'user',
          content: facet.content || eventState.text || '',
          timestamp: timestamp || eventState.timestamp || Date.now(),
          metadata
        });
      } else if (facet.type === 'speech') {
        const speechState = facet.state || {};
        const speechAgentId = facet.agentId || facet.agentName;
        const speechAgentName = facet.agentName || facet.agentId;
        // Match by ID or name — axons emit agentId=botName but register with a different agentId
        const isOwnSpeech = speechAgentId === agentId
          || (agentName != null && speechAgentName === agentName);

        // Own speech = assistant role, other agents' speech = user role with speaker prefix
        if (isOwnSpeech) {
          context.conversation.push({
            role: 'assistant',
            content: facet.content || '',
            timestamp: timestamp || speechState.timestamp || Date.now(),
            metadata: {
              agentId: facet.agentId,
              agentName: facet.agentName
            }
          });
        } else {
          // Other agent's speech - render as user with speaker prefix
          // But skip if we already have an event facet with this content (avoid duplicates)
          const contentWithPrefix = `<${facet.agentName || facet.agentId || 'bot'}> ${facet.content || ''}`;
          const isDuplicate = context.conversation.some(
            (msg: any) => msg.role === 'user' && msg.content === contentWithPrefix
          );
          if (!isDuplicate) {
            context.conversation.push({
              role: 'user',
              content: contentWithPrefix,
              timestamp: timestamp || speechState.timestamp || Date.now(),
              metadata: {
                agentId: facet.agentId,
                agentName: facet.agentName,
                isAgentSpeech: true
              }
            });
          }
        }
      } else if (facet.type === 'thought') {
        context.conversation.push({
          role: 'system',
          content: `[Thought] ${facet.content || ''}`,
          timestamp: timestamp || Date.now(),
          internal: true
        });
      } else if (facet.type === 'action') {
        const actionState = facet.state || {};
        context.conversation.push({
          role: 'assistant',
          content: `[Action: ${actionState.toolName}] ${facet.content || ''}`,
          timestamp: timestamp || Date.now(),
          metadata: {
            toolName: actionState.toolName,
            parameters: actionState.parameters
          }
        });
      }
    };

    // Extract conversation messages from frames (for facets created via components)
    // Pass fromFilteredFrame=true because frames are already hierarchy-filtered
    // (parent frames before fork point are included intentionally)
    //
    // Two passes:
    // 1. Collect addFacet facets into a map (by ID) so rewrite/remove can update them
    // 2. Apply rewriteFacet and removeFacet deltas to keep content current
    //    (e.g. Discord message edits replace "*Thinking*..." with final content)
    const frameFacets = new Map<string, { facet: any; timestamp: string }>();

    for (const frame of frames) {
      for (const delta of frame.deltas || []) {
        if (delta.type === 'addFacet' && delta.facet?.id) {
          frameFacets.set(delta.facet.id, { facet: { ...delta.facet }, timestamp: frame.timestamp });
        } else if (delta.type === 'rewriteFacet' && delta.id && frameFacets.has(delta.id)) {
          // Apply content/state changes to the collected facet
          const entry = frameFacets.get(delta.id)!;
          if (delta.changes) {
            if (delta.changes.content !== undefined) {
              entry.facet.content = delta.changes.content;
            }
            if (delta.changes.state) {
              entry.facet.state = { ...entry.facet.state, ...delta.changes.state };
            }
          }
        } else if (delta.type === 'removeFacet' && delta.id) {
          frameFacets.delete(delta.id);
        }
      }
    }

    for (const [, { facet, timestamp }] of frameFacets) {
      addToConversation(facet, timestamp, true);
    }

    // Scan the facets Map for state/ambient/config facets only.
    // Conversation facets (event, speech, thought, action) are already extracted
    // from frame deltas above — scanning them here would re-add orphaned facets
    // from trimmed frames and cause unbounded context growth.
    for (const [id, facet] of allFacets) {
      // Add state facets to state section
      if (['state', 'ambient', 'config'].includes(facet.type)) {
        // Filter by stream
        if (streamId && (facet as any).streamId && (facet as any).streamId !== streamId) {
          continue;
        }

        // Filter by type if specified
        if (facetTypes.length > 0 && !facetTypes.includes(facet.type)) {
          continue;
        }

        // Add to state section
        context.state[id] = {
          type: facet.type,
          content: (facet as any).content,
          state: (facet as any).state
        };
      }
    }

    // Sort conversation by timestamp
    context.conversation.sort((a: any, b: any) => {
      const timeA = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime();
      const timeB = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime();
      return timeA - timeB;
    });

    return context;
  }

  /**
   * Trim context to fit within token limit
   */
  private trimContext(context: any, maxTokens: number): any {
    const trimmed = { ...context };

    // First, remove internal thoughts
    trimmed.conversation = context.conversation.filter((msg: any) => !msg.internal);

    let tokenCount = estimateTokens(JSON.stringify(trimmed));

    // If still over, truncate oldest messages
    while (tokenCount > maxTokens && trimmed.conversation.length > 10) {
      // Keep at least 10 recent messages
      trimmed.conversation.shift();
      tokenCount = estimateTokens(JSON.stringify(trimmed));
    }

    // If still over, truncate state
    if (tokenCount > maxTokens) {
      trimmed.state = {};
      tokenCount = estimateTokens(JSON.stringify(trimmed));
    }

    // If still over, truncate message content
    if (tokenCount > maxTokens) {
      trimmed.conversation = trimmed.conversation.slice(-5).map((msg: any) => ({
        ...msg,
        content: msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '')
      }));
    }

    return trimmed;
  }

  /**
   * Get active stream for an agent
   */
  getActiveStreamForAgent(agentId: string): StreamRef | undefined {
    const state = this.veilState.getState();

    // Look for agent's active stream in state
    const agentInfo = state.agents.get(agentId);
    if (agentInfo?.metadata?.activeStreamId) {
      return {
        streamId: agentInfo.metadata.activeStreamId,
        streamType: agentInfo.metadata.activeStreamType || 'unknown'
      };
    }

    return state.currentStream;
  }
}
