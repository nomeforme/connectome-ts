/**
 * Event Handler for gRPC EmitEvent requests
 * Routes external events into the Space event queue
 * Also creates facets for known event types so they can be queried via GetContext
 */

import { Space } from '../../spaces/space.js';
import type { SpaceEvent } from '../../spaces/types.js';
import type { Facet } from '../../veil/types.js';
import { createDefaultTransition } from '../../veil/types.js';

/**
 * Result from emitting an event
 */
export interface EmitEventResult {
  success: boolean;
  sequence: number;
  frameUuid: string;
  deltas: Array<{
    type: 'added' | 'changed' | 'removed';
    facet: any;
    oldFacet?: any;
    sequence: number;
    frameUuid: string;
  }>;
  error?: string;
}

/**
 * Handles external event emission via gRPC
 */
export class EventHandler {
  private space: Space;
  private pendingEvents: Map<string, {
    resolve: (result: EmitEventResult) => void;
    reject: (error: Error) => void;
    eventId: string;
  }> = new Map();

  constructor(space: Space) {
    this.space = space;
  }

  /**
   * Create facets for known event types
   * This allows GetContext to find messages in the VEIL state
   */
  /**
   * Helper: atomically allocate sequence + apply frame with try-catch protection.
   * Prevents sequence gaps when applyFrame throws (e.g. bad facet data).
   */
  private safeApplyFrame(
    veilState: ReturnType<typeof this.space.getVEILState>,
    uuid: string,
    deltas: any[],
    activeStream?: { streamId: string; streamType: string },
    skipEphemeralCleanup: boolean = true
  ): number {
    return veilState.allocateAndApplyFrame(
      (seq, ts) => ({
        sequence: seq,
        timestamp: ts,
        uuid,
        activeStream,
        events: [],
        deltas,
        transition: createDefaultTransition(seq, ts),
      }),
      skipEphemeralCleanup
    ).length; // returns change count (0 means no-op but frame still applied)
  }

  private createFacetsForEvent(event: SpaceEvent, eventId: string): void {
    const veilState = this.space.getVEILState();
    const payload = (event.payload || {}) as Record<string, any>;
    const streamId = payload.streamId || event.metadata?._streamId;
    const discordStream = streamId ? { streamId, streamType: 'discord' } : undefined;
    const signalStream = streamId ? { streamId, streamType: 'signal' } : undefined;

    try {

    // Handle discord:message events - create message facet via applyFrame so
    // the facet is recorded in frame deltas with activeStream set (enables stream hierarchy)
    if (event.topic === 'discord:message') {
      const facetId = payload.messageId ? `msg-discord-${payload.messageId}` : `msg-${eventId}`;
      const facet: Facet & { streamId?: string; state?: any } = {
        type: 'event',
        id: facetId,
        content: `<${payload.authorName || 'unknown'}> ${payload.content || ''}`,
        streamId,
        state: {
          eventType: 'discord:message',
          source: 'discord',
          authorId: payload.authorId,
          authorName: payload.authorName,
          messageId: payload.messageId,
          channelId: payload.channelId,
          timestamp: payload.timestamp || Date.now(),
          attachments: payload.attachments
        }
      };

      const deltas = [{ type: 'addFacet' as const, facet }];
      this.safeApplyFrame(veilState, `msg-${eventId}`, deltas, discordStream);
      console.log(`[EventHandler] Created message facet (frame ${veilState.getCurrentSequence()}) for ${payload.authorName}: ${(payload.content || '').substring(0, 50)}...`);
    }

    // Handle discord:messageUpdate - rewrite existing event facet with edited content
    if (event.topic === 'discord:messageUpdate') {
      const facetId = payload.messageId ? `msg-discord-${payload.messageId}` : null;
      if (facetId && veilState.getState().facets.has(facetId)) {
        const deltas = [{
          type: 'rewriteFacet' as const,
          id: facetId,
          changes: {
            content: `<${payload.authorName || 'unknown'}> ${payload.content || ''}`,
            state: { editedAt: payload.editedTimestamp || Date.now() }
          }
        }];
        this.safeApplyFrame(veilState, `edit-${eventId}`, deltas, discordStream);
        console.log(`[EventHandler] Updated message facet ${facetId} (frame ${veilState.getCurrentSequence()}): ${(payload.content || '').substring(0, 50)}...`);
      } else {
        console.log(`[EventHandler] messageUpdate for unknown facet ${facetId}, skipping`);
      }
    }

    // Handle discord:messageDelete - remove the event facet
    if (event.topic === 'discord:messageDelete') {
      const facetId = payload.messageId ? `msg-discord-${payload.messageId}` : null;
      if (facetId && veilState.getState().facets.has(facetId)) {
        const deltas = [{ type: 'removeFacet' as const, id: facetId, mode: 'delete' as const }];
        this.safeApplyFrame(veilState, `delete-${eventId}`, deltas, discordStream);
        console.log(`[EventHandler] Deleted message facet ${facetId} (frame ${veilState.getCurrentSequence()})`);
      } else {
        console.log(`[EventHandler] messageDelete for unknown facet ${facetId}, skipping`);
      }
    }

    // Handle signal:message events - create message facet via applyFrame
    if (event.topic === 'signal:message') {
      const signalMsgKey = (payload.senderUuid || payload.senderNumber) && payload.timestamp
        ? `msg-signal-${payload.senderUuid || payload.senderNumber}-${payload.timestamp}`
        : `msg-${eventId}`;
      const facet: Facet & { streamId?: string; state?: any } = {
        type: 'event',
        id: signalMsgKey,
        content: `<${payload.sender || 'unknown'}> ${payload.content || ''}`,
        streamId,
        state: {
          eventType: 'signal:message',
          source: 'signal',
          senderId: payload.senderUuid || payload.senderNumber,
          senderName: payload.sender,
          groupId: payload.groupId,
          groupName: payload.groupName,
          botPhone: payload.botPhone,
          timestamp: payload.timestamp || Date.now(),
          attachments: payload.attachments
        }
      };

      const deltas = [{ type: 'addFacet' as const, facet }];
      this.safeApplyFrame(veilState, `msg-${eventId}`, deltas, signalStream);
      console.log(`[EventHandler] Created message facet (frame ${veilState.getCurrentSequence()}) for ${payload.sender}: ${(payload.content || '').substring(0, 50)}...`);
    }

    // Handle signal:messageUpdate - rewrite existing event facet with edited content
    if (event.topic === 'signal:messageUpdate') {
      const senderId = payload.senderUuid || payload.senderNumber;
      const facetId = senderId && payload.originalTimestamp
        ? `msg-signal-${senderId}-${payload.originalTimestamp}`
        : null;
      if (facetId && veilState.getState().facets.has(facetId)) {
        const deltas = [{
          type: 'rewriteFacet' as const,
          id: facetId,
          changes: {
            content: `<${payload.sender || 'unknown'}> ${payload.content || ''}`,
            state: { editedAt: payload.editedTimestamp || Date.now() }
          }
        }];
        this.safeApplyFrame(veilState, `edit-${eventId}`, deltas, signalStream);
        console.log(`[EventHandler] Updated signal message facet ${facetId} (frame ${veilState.getCurrentSequence()}): ${(payload.content || '').substring(0, 50)}...`);
      } else {
        console.log(`[EventHandler] signal:messageUpdate for unknown facet ${facetId}, skipping`);
      }
    }

    // Handle signal:messageDelete - remove the event facet
    if (event.topic === 'signal:messageDelete') {
      const senderId = payload.senderUuid || payload.senderNumber;
      const facetId = senderId && payload.targetTimestamp
        ? `msg-signal-${senderId}-${payload.targetTimestamp}`
        : null;
      if (facetId && veilState.getState().facets.has(facetId)) {
        const deltas = [{ type: 'removeFacet' as const, id: facetId, mode: 'delete' as const }];
        this.safeApplyFrame(veilState, `delete-${eventId}`, deltas, signalStream);
        console.log(`[EventHandler] Deleted signal message facet ${facetId} (frame ${veilState.getCurrentSequence()})`);
      } else {
        console.log(`[EventHandler] signal:messageDelete for unknown facet ${facetId}, skipping`);
      }
    }

    // Handle web:message events - create message facet via applyFrame (same pattern as discord/signal)
    if (event.topic === 'web:message') {
      // Client-provided messageId gets a deterministic facet ID so reactions
      // (and other future targeting) can reference it. Absent messageId falls
      // back to the server-generated eventId (non-deterministic — client can't
      // address it later).
      const facetId = payload.messageId ? `msg-web-${payload.messageId}` : `msg-web-${eventId}`;
      const webStream = streamId ? { streamId, streamType: 'web' } : undefined;
      const facet: Facet & { streamId?: string; state?: any } = {
        type: 'event',
        id: facetId,
        content: `<${payload.authorName || 'unknown'}> ${payload.content || ''}`,
        streamId,
        state: {
          eventType: 'web:message',
          source: 'web',
          authorId: payload.authorId,
          authorName: payload.authorName,
          messageId: payload.messageId,
          timestamp: payload.timestamp || Date.now(),
        }
      };

      const deltas = [{ type: 'addFacet' as const, facet }];
      this.safeApplyFrame(veilState, `msg-${eventId}`, deltas, webStream);
      console.log(`[EventHandler] Created web message facet (frame ${veilState.getCurrentSequence()}) for ${payload.authorName}: ${(payload.content || '').substring(0, 50)}...`);
    }

    // Handle veil:ambient events - create ambient facets with optional agent targeting
    if (event.topic === 'veil:ambient') {
      const facetId = `ambient-${payload.targetAgentId || 'all'}-${payload.streamId || 'global'}-${Date.now()}`;
      const ambientStream = streamId ? { streamId, streamType: 'web' } : undefined;
      const facet: Facet & { streamId?: string; targetAgentId?: string } = {
        type: 'ambient',
        id: facetId,
        content: payload.content || '',
        streamId,
        ...(payload.targetAgentId ? { targetAgentId: payload.targetAgentId } : {}),
      };

      const deltas = [{ type: 'addFacet' as const, facet }];
      this.safeApplyFrame(veilState, `ambient-${eventId}`, deltas, ambientStream);
      console.log(`[EventHandler] Created ambient facet ${facetId} (frame ${veilState.getCurrentSequence()})${payload.targetAgentId ? ` target=${payload.targetAgentId}` : ''}`);
    }

    // Handle bot:config events - create ephemeral bot-config facet so bot-runtime subscribers are notified
    if (event.topic === 'bot:config') {
      const targetAgent = payload.targetAgent;
      if (targetAgent) {
        const facet: Facet & { streamId?: string; agentId?: string; state?: any; ephemeral?: boolean } = {
          type: 'bot-config',
          id: `bot-config-${targetAgent}-${Date.now()}`,
          content: '',
          agentId: targetAgent,
          ephemeral: true,
          state: { ...payload },
        };

        const deltas = [{ type: 'addFacet' as const, facet }];
        this.safeApplyFrame(veilState, `config-${eventId}`, deltas);
        console.log(`[EventHandler] Created bot-config facet (frame ${veilState.getCurrentSequence()}) for ${targetAgent}: ${JSON.stringify(payload)}`);
      }
    }

    // Handle agent:command events - create ephemeral facet for bot-runtime to pick up (!stop, !steer)
    if (event.topic === 'agent:command') {
      const facet: Facet & { state?: any; ephemeral?: boolean } = {
        type: 'agent-command',
        id: `agent-command-${eventId}`,
        content: '',
        ephemeral: true,
        state: { ...payload },
      };

      const deltas = [{ type: 'addFacet' as const, facet }];
      this.safeApplyFrame(veilState, `cmd-${eventId}`, deltas);
      console.log(`[EventHandler] Created agent-command facet (frame ${veilState.getCurrentSequence()}): ${payload.type} → ${payload.targetAgent}`);
    }

    // Handle agent:typing-stop events - create ephemeral facet so axon subscribers clear typing indicators
    if (event.topic === 'agent:typing-stop') {
      const facet: Facet & { state?: any; ephemeral?: boolean } = {
        type: 'agent-typing-stop',
        id: `typing-stop-${eventId}`,
        content: '',
        ephemeral: true,
        state: { ...payload },
      };

      const deltas = [{ type: 'addFacet' as const, facet }];
      this.safeApplyFrame(veilState, `typing-stop-${eventId}`, deltas);
      console.log(`[EventHandler] Created typing-stop facet (frame ${veilState.getCurrentSequence()}) for ${payload.targetAgent}`);
    }

    // Handle agent:speech events - create speech facet via applyFrame so gRPC subscribers are notified
    if (event.topic === 'agent:speech') {
      const facet: Facet & { streamId?: string; agentId?: string; agentName?: string; state?: any; attachments?: any[] } = {
        type: 'speech',
        id: `speech-${eventId}`,
        content: payload.content || '',
        streamId,
        agentId: payload.agentId,
        agentName: payload.agentName,
        state: {
          timestamp: payload.timestamp || Date.now(),
          ...(payload.cyclePending ? { cyclePending: true } : {}),
        }
      };

      if (payload.attachments?.length) {
        facet.attachments = payload.attachments;
      }

      const deltas = [{ type: 'addFacet' as const, facet }];
      const grpcStream = streamId ? { streamId, streamType: 'grpc' } : undefined;
      this.safeApplyFrame(veilState, `speech-${eventId}`, deltas, grpcStream);
      console.log(`[EventHandler] Created speech facet (frame ${veilState.getCurrentSequence()}) for ${payload.agentName}: ${(payload.content || '').substring(0, 50)}...`);
    }

    // Handle <platform>:reaction events.
    //
    // Currently a single-purpose channel: `🫥` (U+1FAE5, "dotted-line-face")
    // hides the target message from LLM context. All other emojis are ignored.
    //
    // Semantics: state-based. If ANY user has 🫥 on the message at the moment
    // context is rendered, it's hidden. Set of reactors tracked so add/remove
    // by different users behaves naturally (any-present = hidden).
    //
    // The target message facet stays in VEIL — hidden only affects LLM inference,
    // not storage, search, or delivery. Snapshots contain everything.
    if (
      event.topic === 'discord:reaction'
      || event.topic === 'signal:reaction'
      || event.topic === 'web:reaction'
    ) {
      const HIDE_EMOJI = '🫥';
      const emoji = payload.emoji;
      if (emoji !== HIDE_EMOJI) {
        // Not our concern — future reactions can hook here.
        return;
      }

      // Resolve the deterministic facet ID for the target message. Must
      // match the ID scheme used at message-create time (see above branches).
      let facetId: string | null = null;
      if (event.topic === 'discord:reaction' && payload.messageId) {
        facetId = `msg-discord-${payload.messageId}`;
      } else if (event.topic === 'signal:reaction' && payload.targetAuthorId && payload.targetTimestamp) {
        facetId = `msg-signal-${payload.targetAuthorId}-${payload.targetTimestamp}`;
      } else if (event.topic === 'web:reaction' && payload.facetId) {
        // Web clients pass the facet ID directly (surfaced back to them at
        // message-emit time — see web-axon grpc-main.ts).
        facetId = payload.facetId;
      }

      if (!facetId) {
        console.log(`[EventHandler] ${event.topic}: missing target key, skipping. payload keys=${Object.keys(payload).join(',')}`);
        return;
      }

      const existingFacet: any = veilState.getState().facets.get(facetId);
      if (!existingFacet) {
        console.log(`[EventHandler] ${event.topic} 🫥: target facet ${facetId} not found, skipping`);
        return;
      }

      const userId = payload.userId || 'anon';
      const added = payload.added !== false; // Default to true if unspecified.

      // Track the set of users currently holding 🫥 on this message.
      // Serialized as an array for JSON-friendliness in facet state.
      const existingReactors: string[] = existingFacet.state?.hiddenReactors ?? [];
      let nextReactors: string[];
      if (added) {
        nextReactors = existingReactors.includes(userId)
          ? existingReactors
          : [...existingReactors, userId];
      } else {
        nextReactors = existingReactors.filter((u: string) => u !== userId);
      }

      const nextHidden = nextReactors.length > 0;

      // If nothing changed (idempotent), still emit? No — skip to avoid frame noise.
      if (
        existingReactors.length === nextReactors.length
        && (existingFacet.state?.hiddenFromContext === true) === nextHidden
      ) {
        return;
      }

      // Merge into existing state — rewrite semantics on this codebase are
      // full-replace for the `state` object, so preserve the other fields.
      const mergedState = {
        ...(existingFacet.state ?? {}),
        hiddenFromContext: nextHidden,
        hiddenReactors: nextReactors,
      };

      const deltas = [{
        type: 'rewriteFacet' as const,
        id: facetId,
        changes: { state: mergedState },
      }];
      const grpcStream = streamId ? { streamId, streamType: 'grpc' } : undefined;
      this.safeApplyFrame(veilState, `redact-${eventId}`, deltas, grpcStream);
      console.log(
        `[EventHandler] 🫥 ${added ? 'added' : 'removed'} on ${facetId} by ${userId} — reactors=${nextReactors.length}, hidden=${nextHidden}`,
      );
    }

    } catch (error: any) {
      console.error(`[EventHandler] Failed to create facet for ${event.topic}: ${error.message}`);
    }
  }

  /**
   * Handle an EmitEvent request from a gRPC client
   */
  async handleEmitEvent(event: SpaceEvent, waitForFrame: boolean): Promise<EmitEventResult> {
    // Generate a unique event ID for tracking
    const eventId = `grpc-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    // Add source metadata to track external origin
    const enrichedEvent: SpaceEvent = {
      ...event,
      metadata: {
        ...event.metadata,
        _grpcEventId: eventId,
        _grpcOrigin: true
      }
    };

    // Create facets for known event types (so GetContext can find them)
    this.createFacetsForEvent(event, eventId);

    if (!waitForFrame) {
      // Fire and forget mode
      this.space.emit(enrichedEvent);

      return {
        success: true,
        sequence: 0, // Unknown, frame not waited for
        frameUuid: '',
        deltas: []
      };
    }

    // Wait for frame mode - need to track when the frame completes
    return new Promise((resolve, reject) => {
      // Set up a timeout
      const timeout = setTimeout(() => {
        this.pendingEvents.delete(eventId);
        reject(new Error('Event processing timeout'));
      }, 30000); // 30 second timeout

      // Store the pending event
      this.pendingEvents.set(eventId, { resolve, reject, eventId });

      // Emit the event
      this.space.emit(enrichedEvent);

      // For now, since we don't have direct frame completion hooks,
      // we'll use a workaround: schedule resolution after event loop processes
      // In a full implementation, the Space would notify us of frame completion
      setImmediate(() => {
        clearTimeout(timeout);
        this.pendingEvents.delete(eventId);

        const state = this.space.getVEILState().getState();
        const latestFrame = state.frameHistory[state.frameHistory.length - 1];

        resolve({
          success: true,
          sequence: state.currentSequence,
          frameUuid: latestFrame?.uuid || '',
          deltas: [] // Would need frame delta tracking to populate this
        });
      });
    });
  }

  /**
   * Notify that a frame has completed (called by Space if integrated)
   */
  notifyFrameComplete(
    frameSequence: number,
    frameUuid: string,
    eventIds: string[],
    deltas: any[]
  ): void {
    for (const eventId of eventIds) {
      const pending = this.pendingEvents.get(eventId);
      if (pending) {
        pending.resolve({
          success: true,
          sequence: frameSequence,
          frameUuid,
          deltas: deltas.map(d => ({
            type: d.type,
            facet: d.facet,
            oldFacet: d.oldFacet,
            sequence: frameSequence,
            frameUuid
          }))
        });
        this.pendingEvents.delete(eventId);
      }
    }
  }

  /**
   * Create a SpaceEvent for external emission
   */
  static createExternalEvent(
    topic: string,
    payload: any,
    sourceId: string,
    options?: {
      priority?: 'immediate' | 'high' | 'normal' | 'low';
      sync?: boolean;
      streamId?: string;
      metadata?: Record<string, any>;
    }
  ): SpaceEvent {
    return {
      topic,
      source: {
        componentId: sourceId,
        componentPath: ['external', sourceId]
      },
      payload,
      timestamp: Date.now(),
      priority: options?.priority,
      sync: options?.sync,
      metadata: {
        ...options?.metadata,
        _external: true,
        _streamId: options?.streamId
      }
    };
  }
}
