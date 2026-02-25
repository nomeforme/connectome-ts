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
  private createFacetsForEvent(event: SpaceEvent, eventId: string): void {
    const veilState = this.space.getVEILState();
    const payload = (event.payload || {}) as Record<string, any>;
    const streamId = payload.streamId || event.metadata?._streamId;

    // Handle discord:message events - create message facet
    if (event.topic === 'discord:message') {
      const facet: Facet & { streamId?: string; state?: any } = {
        type: 'event',
        id: `msg-${eventId}`,
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
          attachments: payload.attachments  // Preserve attachments for image processing
        }
      };

      veilState.applyDeltasDirect([{
        type: 'addFacet',
        facet
      }]);

      console.log(`[EventHandler] Created message facet for ${payload.authorName}: ${(payload.content || '').substring(0, 50)}...`);
    }

    // Handle signal:message events - create message facet
    if (event.topic === 'signal:message') {
      const facet: Facet & { streamId?: string; state?: any } = {
        type: 'event',
        id: `msg-${eventId}`,
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
          attachments: payload.attachments  // Preserve attachments for image processing
        }
      };

      veilState.applyDeltasDirect([{
        type: 'addFacet',
        facet
      }]);

      console.log(`[EventHandler] Created message facet for ${payload.sender}: ${(payload.content || '').substring(0, 50)}...`);
    }

    // Handle agent:speech events - create speech facet via applyFrame so gRPC subscribers are notified
    if (event.topic === 'agent:speech') {
      const facet: Facet & { streamId?: string; agentId?: string; agentName?: string; state?: any } = {
        type: 'speech',
        id: `speech-${eventId}`,
        content: payload.content || '',
        streamId,
        agentId: payload.agentId,
        agentName: payload.agentName,
        state: {
          timestamp: payload.timestamp || Date.now()
        }
      };

      const deltas = [{ type: 'addFacet' as const, facet }];
      const frameSequence = veilState.getNextSequence();
      const timestamp = new Date().toISOString();
      veilState.applyFrame({
        sequence: frameSequence,
        timestamp,
        uuid: `speech-${eventId}`,
        activeStream: streamId ? { streamId, streamType: 'grpc' } : undefined,
        events: [],
        deltas,
        transition: createDefaultTransition(frameSequence, timestamp)
      }, true); // skipEphemeralCleanup — preserve existing ephemeral facets

      console.log(`[EventHandler] Created speech facet (frame ${frameSequence}) for ${payload.agentName}: ${(payload.content || '').substring(0, 50)}...`);
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
