/**
 * GrpcMessageReceptor - Proper FLEX Component for gRPC event → facet conversion
 *
 * Handles incoming events from gRPC clients and creates facets via addOperation(),
 * ensuring they are properly recorded in frame deltas (not bypassing the frame system).
 *
 * Replaces the broken applyDeltasDirect pattern in EventHandler.
 */

import { Component } from '../../spaces/component.js';
import { ExecutionContext } from '../../spaces/types.js';
import { priorityConstraint, ComponentPriority } from '../../spaces/constraints.js';
import { createEventFacet, createSpeechFacet, wrapFacetsAsDeltas } from '../../helpers/factories.js';

export class GrpcMessageReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
  topics = ['discord:message', 'signal:message', 'agent:speech'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event) return;

    const payload = (event.payload || {}) as Record<string, any>;
    const streamId = payload.streamId || event.metadata?._streamId;
    const eventId = event.metadata?._grpcEventId || `grpc-${Date.now()}`;

    if (event.topic === 'discord:message') {
      this.handleDiscordMessage(payload, streamId, eventId);
    } else if (event.topic === 'signal:message') {
      this.handleSignalMessage(payload, streamId, eventId);
    } else if (event.topic === 'agent:speech') {
      this.handleAgentSpeech(payload, streamId, eventId);
    }
  }

  private handleDiscordMessage(payload: Record<string, any>, streamId: string, eventId: string): void {
    const facet = createEventFacet({
      id: `msg-${eventId}`,
      content: `<${payload.authorName || 'unknown'}> ${payload.content || ''}`,
      source: 'discord',
      eventType: 'discord:message',
      streamId,
      metadata: {
        authorId: payload.authorId,
        authorName: payload.authorName,
        messageId: payload.messageId,
        channelId: payload.channelId,
        timestamp: payload.timestamp || Date.now(),
        attachments: payload.attachments
      }
    });

    for (const delta of wrapFacetsAsDeltas([facet])) {
      this.addOperation(delta);
    }

    console.log(`[GrpcMessageReceptor] Created message facet for ${payload.authorName}: ${(payload.content || '').substring(0, 50)}...`);
  }

  private handleSignalMessage(payload: Record<string, any>, streamId: string, eventId: string): void {
    const facet = createEventFacet({
      id: `msg-${eventId}`,
      content: `<${payload.sender || 'unknown'}> ${payload.content || ''}`,
      source: 'signal',
      eventType: 'signal:message',
      streamId,
      metadata: {
        senderId: payload.senderUuid || payload.senderNumber,
        senderName: payload.sender,
        groupId: payload.groupId,
        groupName: payload.groupName,
        botPhone: payload.botPhone,
        timestamp: payload.timestamp || Date.now(),
        attachments: payload.attachments
      }
    });

    for (const delta of wrapFacetsAsDeltas([facet])) {
      this.addOperation(delta);
    }

    console.log(`[GrpcMessageReceptor] Created message facet for ${payload.sender}: ${(payload.content || '').substring(0, 50)}...`);
  }

  private handleAgentSpeech(payload: Record<string, any>, streamId: string, eventId: string): void {
    const facet = createSpeechFacet({
      id: `speech-${eventId}`,
      content: payload.content || '',
      agentId: payload.agentId,
      agentName: payload.agentName,
      streamId
    });

    for (const delta of wrapFacetsAsDeltas([facet])) {
      this.addOperation(delta);
    }

    console.log(`[GrpcMessageReceptor] Created speech facet for ${payload.agentName}: ${(payload.content || '').substring(0, 50)}...`);
  }
}
