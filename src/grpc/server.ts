/**
 * Connectome gRPC Server Bootstrap
 * Initializes and manages the gRPC server for the Connectome service
 */

import { ConnectomeServer, type ConnectomeServerConfig, type ConnectomeServiceHandlers } from '@connectome/grpc-common';
import { Space } from '../spaces/space.js';
import { VEILStateManager } from '../veil/veil-state.js';
import { EventHandler } from './handlers/event-handler.js';
import { SubscriptionHandler } from './handlers/subscription-handler.js';
import { ContextHandler } from './handlers/context-handler.js';
import { createDefaultTransition } from '../veil/types.js';

/**
 * gRPC server configuration with Space integration
 */
export interface GrpcServerOptions extends ConnectomeServerConfig {
  space: Space;
  veilState: VEILStateManager;
}

/**
 * Start time for uptime tracking
 */
let serverStartTime: number = 0;

/**
 * Create and configure the gRPC server with Connectome handlers
 */
export function createGrpcServer(options: GrpcServerOptions): ConnectomeServer {
  const { space, veilState, ...serverConfig } = options;

  const server = new ConnectomeServer(serverConfig);

  // Create handlers
  const eventHandler = new EventHandler(space);
  const subscriptionHandler = new SubscriptionHandler(space, veilState);
  const contextHandler = new ContextHandler(space, veilState);

  // Track registered agents
  const registeredAgents = new Map<string, {
    agentId: string;
    agentName: string;
    agentType: string;
    capabilities: string[];
    sessionToken: string;
    createdAt: string;
    lastActiveAt: string;
  }>();

  // Set up service handlers
  const handlers: ConnectomeServiceHandlers = {
    // Health check
    async health() {
      const state = veilState.getState();
      return {
        healthy: true,
        currentSequence: state.currentSequence,
        activeStreams: state.streams.size,
        activeAgents: state.agents.size,
        uptimeMs: serverStartTime > 0 ? Date.now() - serverStartTime : 0
      };
    },

    // Emit event to Space
    async emitEvent(event, waitForFrame) {
      return eventHandler.handleEmitEvent(event, waitForFrame);
    },

    // Subscribe to facet changes
    subscribeToFacets(request, callback, onEnd) {
      return subscriptionHandler.handleSubscribe(request, callback, onEnd);
    },

    // Register an agent
    async registerAgent(request) {
      const { agentId, agentName, agentType, capabilities, metadata } = request;

      // Generate session token
      const sessionToken = `session-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
      const now = new Date().toISOString();

      // Store agent info
      registeredAgents.set(agentId, {
        agentId,
        agentName,
        agentType: agentType || 'assistant',
        capabilities: capabilities || [],
        sessionToken,
        createdAt: now,
        lastActiveAt: now
      });

      // Emit agent registration event
      space.emit({
        topic: 'agent:registered',
        source: {
          componentId: 'grpc-server',
          componentPath: ['grpc', 'server']
        },
        payload: {
          agentId,
          agentName,
          agentType,
          capabilities,
          metadata
        },
        timestamp: Date.now()
      });

      console.log(`[GrpcServer] Registered agent: ${agentName} (${agentId})`);

      return {
        agentId,
        sessionToken,
        success: true
      };
    },

    // Get rendered context for agent
    async getContext(request) {
      // Resolve agent name from registry so context handler can match speech by name
      const agent = registeredAgents.get(request.agentId);
      if (agent) {
        request.agentName = agent.agentName;
      }
      return contextHandler.handleGetContext(request);
    },

    // Create a new stream
    async createStream(request) {
      const { streamId, streamType, metadata, parentStreamId } = request;

      // Snapshot current sequence as fork point (before any new frames)
      const forkSequence = parentStreamId ? veilState.getCurrentSequence() : undefined;

      // Register stream in VEILState (enables hierarchy-aware context)
      veilState.registerStream({
        id: streamId,
        name: metadata?.channelName || streamId,
        metadata,
        parentId: parentStreamId || undefined,
        forkSequence,
      });

      // Emit stream creation event
      space.emit({
        topic: 'stream:create',
        source: {
          componentId: 'grpc-server',
          componentPath: ['grpc', 'server']
        },
        payload: {
          streamId,
          streamType,
          metadata,
          parentStreamId: parentStreamId || undefined,
        },
        timestamp: Date.now()
      });

      console.log(`[GrpcServer] Created stream: ${streamId} (${streamType})${parentStreamId ? ` parent=${parentStreamId} fork@${forkSequence}` : ' (no parent)'} [raw parentStreamId=${JSON.stringify(parentStreamId)}]`);

      return {
        streamId,
        streamType,
        success: true
      };
    },

    // Get state snapshot
    async getStateSnapshot(request) {
      const { sequence, facetTypes, streamIds } = request;
      const targetSequence = sequence || veilState.getState().currentSequence;

      // Get state at requested sequence
      const snapshot = veilState.getStateAtSequence(targetSequence);
      const state = veilState.getState();

      // Filter facets
      let facets = Array.from(snapshot.facets.values());

      if (facetTypes && facetTypes.length > 0) {
        facets = facets.filter(f => facetTypes.includes(f.type));
      }

      if (streamIds && streamIds.length > 0) {
        facets = facets.filter(f => {
          const streamId = (f as any).streamId;
          return !streamId || streamIds.includes(streamId);
        });
      }

      // Convert streams and agents
      const streams = Array.from(state.streams.values()).map(s => ({
        id: s.id,
        name: s.name || s.id,
        metadata: s.metadata || {},
        parentId: s.parentId || '',
      }));

      const agents = Array.from(state.agents.values()).map(a => ({
        id: a.id,
        name: a.name,
        type: a.type || 'assistant',
        capabilities: a.capabilities || [],
        metadata: a.metadata || {},
        createdAt: a.createdAt,
        lastActiveAt: a.lastActiveAt || a.createdAt
      }));

      return {
        sequence: targetSequence,
        timestamp: new Date().toISOString(),
        facets,
        streams,
        agents,
        currentStream: state.currentStream
      };
    },

    // Get frames by sequence range
    async getFrames(request) {
      const { fromSequence, toSequence, limit, streamIds } = request;
      const state = veilState.getState();

      let frames = state.frameHistory.filter(f => {
        if (fromSequence && f.sequence < fromSequence) return false;
        if (toSequence && f.sequence > toSequence) return false;
        return true;
      });

      // Filter by stream if specified
      if (streamIds && streamIds.length > 0) {
        frames = frames.filter(f => {
          if (!f.activeStream) return true; // Include frames without stream
          return streamIds.includes(f.activeStream.streamId);
        });
      }

      // Apply limit
      if (limit && limit > 0) {
        frames = frames.slice(0, limit);
      }

      return {
        frames: frames.map(f => ({
          sequence: f.sequence,
          timestamp: f.timestamp,
          uuid: f.uuid,
          activeStream: f.activeStream,
          events: f.events,
          deltas: f.deltas
        })),
        currentSequence: state.currentSequence
      };
    },

    // Activate an agent for a stream
    async activateAgent(request) {
      const { agentId, streamId, reason, priority, metadata } = request;
      console.log(`[GrpcServer] activateAgent: agent=${agentId} stream=${streamId} reason=${reason}`);

      // Map priority to Connectome format
      const priorityMap: Record<string, 'low' | 'normal' | 'high'> = {
        'ACTIVATION_LOW': 'low',
        'ACTIVATION_NORMAL': 'normal',
        'ACTIVATION_HIGH': 'high',
        'ACTIVATION_CRITICAL': 'high' // Map critical to high
      };

      const mappedPriority = priorityMap[priority] || 'normal';
      const activationId = `activation-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

      // Build the facet deltas to push into VEIL
      const deltas: any[] = [];

      // 1. agent-activation facet
      deltas.push({
        type: 'addFacet',
        facet: {
          id: activationId,
          type: 'agent-activation',
          streamId,
          state: {
            reason: reason || 'gRPC activation',
            priority: mappedPriority,
            sourceAgentId: agentId,
            metadata: metadata || {}
          }
        }
      });

      // 2. rendered-context facet (render context for the agent)
      const agent = registeredAgents.get(agentId);
      try {
        const contextResult = await contextHandler.handleGetContext({
          agentId,
          agentName: agent?.agentName || '',
          streamId,
          maxFrames: 100,
          maxTokens: 200000,
          facetTypes: []
        });

        deltas.push({
          type: 'addFacet',
          facet: {
            id: `ctx-${activationId}`,
            type: 'rendered-context',
            streamId,
            state: {
              activationId,
              tokenCount: contextResult.tokenCount,
              context: contextResult.contextJson.length > 0
                ? JSON.parse(Buffer.from(contextResult.contextJson).toString('utf8'))
                : null
            }
          }
        });

        console.log(`[GrpcServer] Activation ${activationId}: ${contextResult.tokenCount} tokens context`);
      } catch (err: any) {
        console.error(`[GrpcServer] Failed to render context for activation ${activationId}: ${err.message}`);
      }

      // Apply as a proper frame so subscribers are notified
      const frameSequence = veilState.getNextSequence();
      const timestamp = new Date().toISOString();
      veilState.applyFrame({
        sequence: frameSequence,
        timestamp,
        uuid: activationId,
        activeStream: { streamId, streamType: 'grpc' },
        events: [],
        deltas,
        transition: createDefaultTransition(frameSequence, timestamp)
      }, true); // skipEphemeralCleanup — don't delete existing ephemeral facets

      console.log(`[GrpcServer] Activation frame ${frameSequence} committed for ${agentId} on ${streamId}`);

      // Update agent's last active time
      if (agent) {
        agent.lastActiveAt = new Date().toISOString();
      }

      return {
        success: true,
        activationId
      };
    }
  };

  server.setHandlers(handlers);

  // Track start time when server starts
  server.on('started', () => {
    serverStartTime = Date.now();
  });

  return server;
}

/**
 * Start the gRPC server
 */
export async function startGrpcServer(options: GrpcServerOptions): Promise<ConnectomeServer> {
  const server = createGrpcServer(options);
  await server.start();
  return server;
}
