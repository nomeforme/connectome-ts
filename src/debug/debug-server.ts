import express from 'express';
import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { debugLLMBridge, DebugLLMRequest } from '../llm/debug-llm-bridge';

import type { Space } from '../spaces/space';
import { VEILStateManager } from '../veil/veil-state';
import type { Frame, Facet, StreamRef, StreamInfo } from '../veil/types';
import { hasContentAspect } from '../veil/types';
import type { SpaceEvent, ComponentRef } from '../spaces/types';
import type { DebugObserver, DebugFrameStartContext, DebugFrameCompleteContext, DebugEventContext, DebugAgentFrameContext, DebugComponentSnapshot, ComponentExecutionRecord } from './types';
import { deterministicUUID } from '../utils/uuid';
import type { Component } from '../spaces/component';
import type { RenderedContext } from '../hud/types-v2';
import { serializeVEILState } from '../persistence/serialization';

export interface DebugServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  maxFrames: number;
  retentionMinutes: number;
  corsOrigins: string[];
}

const DEFAULT_CONFIG: DebugServerConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 8888,
  maxFrames: 1000,
  retentionMinutes: 60,
  corsOrigins: ['*']
};

const MAX_SANITIZE_DEPTH = 8;
const MAX_COLLECTION_PREVIEW = 20;
const FACET_TREE_MAX_DEPTH = 10;

interface DebugEventRecord {
  id: string;
  topic: string;
  source: ComponentRef;
  payload: any;
  timestamp: number;
}

type FrameKind = 'incoming' | 'outgoing' | 'in-stream' | 'out-stream';

interface DebugFrameRecord {
  uuid: string;
  sequence: number;
  timestamp: string;
  kind: FrameKind;
  deltas: any[];
  events: DebugEventRecord[];
  components?: DebugComponentSnapshot[];
  executions?: ComponentExecutionRecord[];
  queueLength?: number;
  durationMs?: number;
  processedEvents?: number;
  agent?: {
    id?: string;
    name?: string;
  };
  activeStream?: StreamRef;
  renderedContext?: RenderedContext;
  /** Sub-cycle trace for debugging sync event processing */
  subCycleTrace?: import('../spaces/types').SubCycleInfo[];
  /** For streaming frames: the activation ID this stream belongs to */
  streamingActivationId?: string;
  /** For streaming frames: sequence number within the stream */
  streamSequence?: number;
}

interface DebugMetrics {
  frameCount: number;
  lastFrameTimestamp?: string;
  averageDurationMs: number;
  totalEvents: number;
}

function sanitizePayload(value: any, depth: number = 0, seen: WeakSet<object> = new WeakSet()): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth > MAX_SANITIZE_DEPTH && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_COLLECTION_PREVIEW);
    }
    if (value instanceof Map) {
      return {
        '[depth-limit]': true,
        size: value.size,
        keys: Array.from(value.keys()).slice(0, MAX_COLLECTION_PREVIEW)
      };
    }
    if (value instanceof Set) {
      return {
        '[depth-limit]': true,
        size: value.size
      };
    }
    return {
      '[depth-limit]': true,
      keys: Object.keys(value).slice(0, MAX_COLLECTION_PREVIEW)
    };
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_COLLECTION_PREVIEW).map(item => sanitizePayload(item, depth + 1, seen));
    }

    if (value instanceof Map) {
      return Array.from(value.entries())
        .slice(0, MAX_COLLECTION_PREVIEW)
        .map(([key, val]) => [sanitizePayload(key, depth + 1, seen), sanitizePayload(val, depth + 1, seen)]);
    }

    if (value instanceof Set) {
      return Array.from(value.values())
        .slice(0, MAX_COLLECTION_PREVIEW)
        .map(val => sanitizePayload(val, depth + 1, seen));
    }

    if (Buffer.isBuffer(value)) {
      const stringValue = value.toString('utf8');
      return stringValue.length > 256 ? `${stringValue.slice(0, 256)}…` : stringValue;
    }

    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'function') continue;
      if (key.startsWith('_')) continue;
      result[key] = sanitizePayload(val, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

class DebugStateTracker extends EventEmitter implements DebugObserver {
  private frames: DebugFrameRecord[] = [];
  private frameIndex: Map<string, DebugFrameRecord> = new Map();
  private metrics: DebugMetrics = {
    frameCount: 0,
    averageDurationMs: 0,
    totalEvents: 0
  };
  private completedFrames = 0;

  constructor(private maxFrames: number) {
    super();
  }

  onFrameStart(frame: Frame, context: DebugFrameStartContext): void {
    const uuid = frame.uuid || deterministicUUID(`frame-${frame.sequence}`);
    const inferred = inferFrameKind(frame, 'incoming');
    const record: DebugFrameRecord = {
      uuid,
      sequence: frame.sequence,
      timestamp: frame.timestamp,
      kind: inferred.kind,
      events: [],
      deltas: [],
      components: context.components,
      queueLength: context.queuedEvents,
      activeStream: frame.activeStream,
      streamingActivationId: inferred.streamingActivationId,
      streamSequence: inferred.streamSequence
    };
    this.insertFrame(record);
    this.metrics.frameCount += 1;
    this.metrics.lastFrameTimestamp = frame.timestamp;
    this.emit('frame:start', record);
  }

  onFrameEvent(frame: Frame, event: SpaceEvent, context: DebugEventContext): void {
    const record = this.lookup(frame);
    if (!record) return;

    const eventRecord: DebugEventRecord = {
      id: deterministicUUID(`${record.uuid}:${record.events.length}`),
      topic: event.topic,
      source: sanitizePayload(event.source),
      payload: sanitizePayload(event.payload),
      timestamp: event.timestamp
    };

    record.events.push(eventRecord);
    this.metrics.totalEvents += 1;
    this.emit('frame:event', { frame: record, event: eventRecord });
  }

  onFrameComplete(frame: Frame, context: DebugFrameCompleteContext): void {
    const record = this.lookup(frame);
    if (!record) return;

    record.deltas = frame.deltas.map(op => sanitizePayload(op));
    record.durationMs = context.durationMs;
    record.processedEvents = context.processedEvents;
    record.executions = context.componentExecutions;
    record.activeStream = frame.activeStream;
    record.events = sanitizeFrameEvents(frame, record.uuid);

    // Update kind with final inference (may have more info now)
    const inferred = inferFrameKind(frame, record.kind);
    record.kind = inferred.kind;
    if (inferred.streamingActivationId) {
      record.streamingActivationId = inferred.streamingActivationId;
      record.streamSequence = inferred.streamSequence;
    }

    // Include sub-cycle trace if present
    if (frame.subCycleTrace && frame.subCycleTrace.length > 0) {
      record.subCycleTrace = frame.subCycleTrace;
    }

    if (context.durationMs > 0) {
      this.completedFrames += 1;
      const totalDuration = this.metrics.averageDurationMs * (this.completedFrames - 1) + context.durationMs;
      this.metrics.averageDurationMs = totalDuration / this.completedFrames;
    }

    this.emit('frame:complete', record);
  }

  onAgentFrame(frame: Frame, context: DebugAgentFrameContext): void {
    const uuid = frame.uuid || deterministicUUID(`agent-${frame.sequence}`);
    const inferred = inferFrameKind(frame, 'outgoing');
    const record: DebugFrameRecord = {
      uuid,
      sequence: frame.sequence,
      timestamp: frame.timestamp,
      kind: inferred.kind,
      events: sanitizeFrameEvents(frame, uuid),
      deltas: frame.deltas.map(op => sanitizePayload(op)),
      agent: context.agentId || context.agentName ? {
        id: context.agentId,
        name: context.agentName
      } : undefined,
      activeStream: frame.activeStream,
      subCycleTrace: frame.subCycleTrace && frame.subCycleTrace.length > 0
        ? frame.subCycleTrace
        : undefined,
      streamingActivationId: inferred.streamingActivationId,
      streamSequence: inferred.streamSequence
    };

    if ((frame as any).renderedContext) {
      record.renderedContext = sanitizePayload((frame as any).renderedContext) as RenderedContext;
    }

    this.insertFrame(record);
    this.metrics.frameCount += 1;
    this.metrics.lastFrameTimestamp = frame.timestamp;
    this.metrics.totalEvents += record.events.length;
    this.emit('frame:outgoing', record);
  }


  getFrames(limit?: number, offset: number = 0): DebugFrameRecord[] {
    // Sort frames in descending order by sequence (most recent first)
    const sortedFrames = [...this.frames].sort((a, b) => b.sequence - a.sequence);
    
    // Apply pagination
    const start = offset;
    const end = limit ? offset + limit : sortedFrames.length;
    
    const result = sortedFrames.slice(start, end);

    return result;
  }

  getFrame(uuid: string): DebugFrameRecord | undefined {
    return this.frameIndex.get(uuid);
  }

  getMetrics(): DebugMetrics {
    return { ...this.metrics };
  }

  clear(): void {
    this.frames = [];
    this.frameIndex.clear();
    this.metrics = {
      frameCount: 0,
      averageDurationMs: 0,
      totalEvents: 0
    };
    this.completedFrames = 0;
  }

  private lookup(frame: Frame): DebugFrameRecord | undefined {
    const uuid = frame.uuid || deterministicUUID(`${frame.sequence}`);
    return this.frameIndex.get(uuid);
  }

  private insertFrame(record: DebugFrameRecord): void {
    this.frames.push(record);
    this.frameIndex.set(record.uuid, record);

    // If we exceed max frames, remove the oldest by sequence (not by insertion order)
    if (this.frames.length > this.maxFrames) {
      
      // Sort by sequence to find the oldest
      const sorted = [...this.frames].sort((a, b) => a.sequence - b.sequence);
      const toRemove = sorted.slice(0, this.frames.length - this.maxFrames);
      
      // Remove the oldest frames
      for (const frame of toRemove) {
        this.frameIndex.delete(frame.uuid);
        const idx = this.frames.indexOf(frame);
        if (idx >= 0) {
          this.frames.splice(idx, 1);
        }
      }
    }
  }

  removeFramesBySequence(sequences: number[]): number {
    const sequenceSet = new Set(sequences);
    const before = this.frames.length;
    
    // Remove from index
    for (const frame of this.frames) {
      if (sequenceSet.has(frame.sequence)) {
        this.frameIndex.delete(frame.uuid);
      }
    }
    
    // Remove from array
    this.frames = this.frames.filter(frame => !sequenceSet.has(frame.sequence));
    
    const removed = before - this.frames.length;
    return removed;
  }

  loadHistoricalFrame(record: DebugFrameRecord): void {
    // Don't add duplicates
    if (this.frameIndex.has(record.uuid)) {
      return;
    }
    
    // Insert the frame
    this.insertFrame(record);
    
    // Update metrics
    this.metrics.frameCount += 1;
    this.metrics.totalEvents += record.events.length;
    this.metrics.lastFrameTimestamp = record.timestamp;
  }

}

interface InferredFrameInfo {
  kind: FrameKind;
  streamingActivationId?: string;
  streamSequence?: number;
}

function inferFrameKind(
  frame: Frame,
  fallback: FrameKind = 'incoming'
): InferredFrameInfo {
  if (Array.isArray(frame.events)) {
    // Check for streaming events first (activation:stream)
    for (const event of frame.events) {
      if (event?.topic === 'activation:stream') {
        const payload = event.payload as any;
        return {
          kind: 'in-stream',
          streamingActivationId: payload?.activationId,
          streamSequence: payload?.streamSequence
        };
      }
      // Future: out-stream for speech synthesis, etc.
      // if (event?.topic === 'speech:stream') {
      //   return { kind: 'out-stream', ... };
      // }
    }

    // Check for agent-generated events by looking at VEIL operations from agent components
    const hasAgentEvents = frame.events.some(event => {
      if (event?.topic === 'veil:operation' && event.source) {
        // Check if source is an agent element/component
        return event.source.componentId?.includes('agent') ||
               event.source.componentType?.includes('Agent');
      }
      return false;
    });
    if (hasAgentEvents) {
      return { kind: 'outgoing' };
    }
  }
  return { kind: fallback };
}

function sanitizeFrameEvents(
  frame: Frame,
  recordUuid: string
): DebugEventRecord[] {
  if (!Array.isArray(frame.events) || frame.events.length === 0) {
    return [];
  }

  return frame.events.map((event, index) => ({
    id: deterministicUUID(`${recordUuid}:evt:${index}`),
    topic: event.topic,
    source: sanitizePayload(event.source),
    payload: sanitizePayload(event.payload),
    timestamp: event.timestamp
  }));
}

interface SerializedComponent {
  type: string;
  enabled: boolean;
  state: Record<string, any>;
}

function serializeComponent(component: Component): SerializedComponent {
  const state: Record<string, any> = {};
  for (const key of Object.keys(component as any)) {
    if (key.startsWith('_')) continue;
    const value = (component as any)[key];
    if (typeof value === 'function') continue;
    state[key] = sanitizePayload(value);
  }
  return {
    type: component.constructor.name,
    enabled: component.enabled,
    state
  };
}

interface SerializedVEILState {
  facets: Array<Facet & { id: string }>;
  streams: Array<{ id: string; info: StreamInfo }>;
  currentStream?: StreamRef;
  sequence: number;
}

function sanitizeFacetTreeNode(facet: Facet, depth: number = 0): any {
  const content = hasContentAspect(facet) ? facet.content : '';
  const baseNode = {
    id: facet.id,
    type: facet.type,
    displayName: facet.displayName || '',
    content
  };

  if (depth >= FACET_TREE_MAX_DEPTH) {
    return {
      ...baseNode,
      truncated: true,
      childrenCount: facet.children ? facet.children.length : 0
    };
  }

  return {
    ...baseNode,
    attributes: facet.attributes ? sanitizePayload(facet.attributes, depth + 1) : undefined,
    scope: facet.scope || undefined,
    saliency: facet.saliency ? sanitizePayload(facet.saliency, depth + 1) : undefined,
    children: (facet.children || []).map(child => sanitizeFacetTreeNode(child, depth + 1))
  };
}

function describeFacet(facet: Facet): string {
  const content = hasContentAspect(facet) ? facet.content : '';
  return `${facet.id}:${facet.type || 'unknown'}:${facet.displayName || content}`;
}

interface FrameListResponse {
  frames: DebugFrameRecord[];
  metrics: DebugMetrics;
}

export class DebugServer {
  private readonly config: DebugServerConfig;
  private readonly app = express();
  private readonly httpServer: Server;
  private readonly wsServer: WebSocketServer;
  private readonly tracker: DebugStateTracker;
  private readonly veilState: VEILStateManager;
  private subscriptions: Array<() => void> = [];
  private debugLLMEnabled: boolean;

  constructor(private readonly space: Space, config?: Partial<DebugServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.httpServer = createServer(this.app);
    this.wsServer = new WebSocketServer({ server: this.httpServer });
    this.tracker = new DebugStateTracker(this.config.maxFrames);
    this.veilState = space.getVEILState();
    this.debugLLMEnabled = debugLLMBridge.isEnabled();

    this.space.addDebugObserver(this.tracker);

    // Load historical frames from VEIL state
    this.loadHistoricalFrames();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupDebugLLMBridge();
    this.setupStaticAssets();  // Move to end so 404 handler comes last
  }

  private loadHistoricalFrames(): void {
    const veilState = this.veilState.getState();
    const frameHistory = veilState.frameHistory;

    // Convert VEIL frames to debug frame records
    frameHistory.forEach(frame => {
      const inferred = inferFrameKind(frame, 'incoming');
      const uuid = frame.uuid || deterministicUUID(`${inferred.kind}-${frame.sequence}`);

      const record: DebugFrameRecord = {
        uuid,
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        kind: inferred.kind,
        events: sanitizeFrameEvents(frame, uuid),
        deltas: (frame.deltas || []).map((op: any) => sanitizePayload(op)),
        queueLength: 0,
        activeStream: frame.activeStream,
        subCycleTrace: frame.subCycleTrace && frame.subCycleTrace.length > 0
          ? frame.subCycleTrace
          : undefined,
        streamingActivationId: inferred.streamingActivationId,
        streamSequence: inferred.streamSequence
      };

      // Add the frame to the tracker
      this.tracker.loadHistoricalFrame(record);
    });
  }

  start(): void {
    if (!this.config.enabled) return;
    
    this.httpServer.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(`⚠️  Debug UI port ${this.config.port} is already in use. Debug UI will not be available.`);
        console.warn(`    Try running with --debug-port=<different-port> to use a different port.`);
      } else {
        console.error('Debug server error:', error);
      }
    });
    
    this.httpServer.listen(this.config.port, this.config.host, () => {
      console.log(`🔍 Debug UI available at http://${this.config.host}:${this.config.port}`);
    });

    const unsubscribe = this.veilState.subscribe(() => {
      const state = serializeVEILState(this.veilState.getState());
      this.broadcast({ type: 'state:changed', payload: state });
    });
    this.subscriptions.push(unsubscribe);

    this.tracker.on('frame:start', (frame: DebugFrameRecord) => {
      this.broadcast({ type: 'frame:start', payload: frame });
    });
    this.tracker.on('frame:complete', (frame: DebugFrameRecord) => {
      this.broadcast({ type: 'frame:complete', payload: frame });
    });
    this.tracker.on('frame:outgoing', (frame: DebugFrameRecord) => {
      this.broadcast({ type: 'frame:outgoing', payload: frame });
    });
    this.tracker.on('frame:event', ({ frame, event }: { frame: DebugFrameRecord; event: DebugEventRecord }) => {
      this.broadcast({ type: 'frame:event', payload: { frameId: frame.uuid, event } });
    });
    this.tracker.on('frame:context', ({ frame }: { frame: DebugFrameRecord; context: RenderedContext }) => {
      this.broadcast({ type: 'frame:context', payload: frame });
    });
  }

  stop(): void {
    for (const unsubscribe of this.subscriptions) {
      try {
        unsubscribe();
      } catch (err) {
        console.warn('Failed to remove debug subscription', err);
      }
    }
    this.subscriptions = [];
    this.wsServer.close();
    this.httpServer.close();
  }

  private setupDebugLLMBridge(): void {
    const handleProviderChange = (enabled: boolean) => {
      this.debugLLMEnabled = enabled;
      this.broadcast({ type: 'debugLLM:enabled', payload: { enabled } });
    };
    const handleCreated = (request: DebugLLMRequest) => {
      if (!this.debugLLMEnabled) return;
      this.broadcast({ type: 'debugLLM:request-created', payload: request });
    };
    const handleUpdated = (request: DebugLLMRequest) => {
      if (!this.debugLLMEnabled) return;
      this.broadcast({ type: 'debugLLM:request-updated', payload: request });
    };

    debugLLMBridge.on('provider-change', handleProviderChange);
    debugLLMBridge.on('request-created', handleCreated);
    debugLLMBridge.on('request-updated', handleUpdated);

    this.subscriptions.push(() => {
      debugLLMBridge.off('provider-change', handleProviderChange);
      debugLLMBridge.off('request-created', handleCreated);
      debugLLMBridge.off('request-updated', handleUpdated);
    });
  }

  private setupMiddleware(): void {
    console.log('[DebugServer] Setting up middleware...');
    
    this.app.use(express.json({ limit: '1mb' }));
    
    // Request logging middleware
    this.app.use((req, res, next) => {
      next();
    });
    
    this.app.use((req, res, next) => {
      if (this.config.corsOrigins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else {
        const origin = req.headers.origin || '';
        if (this.config.corsOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
        }
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    
    console.log('[DebugServer] Middleware setup complete');
  }

  private setupRoutes(): void {
    console.log('[DebugServer] Setting up API routes...');
    
    this.app.get('/api/frames', (req, res) => {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const frames = this.tracker.getFrames(limit, offset);
      
      // Enrich frames with rendered-context from VEIL
      const enrichedFrames = frames.map(frame => {
        // Get VEIL state at this frame
        const veilSnapshot = this.veilState.getStateAtSequence(frame.sequence);
        const facets = Array.from(veilSnapshot.facets.values());
        
        // Find activation in this frame
        const activationFacet = (frame as any).deltas?.find((d: any) => 
          d.type === 'addFacet' && d.facet?.type === 'agent-activation'
        )?.facet;
        
        let renderedContext = null;
        if (activationFacet) {
          // Find rendered-context facet for this activation
          const contextFacet = facets.find(f => 
            f.type === 'rendered-context' && 
            (f as any).state?.activationId === activationFacet.id
          );
          renderedContext = contextFacet ? (contextFacet as any).state?.context : null;
        }
        
        // Fallback to frame property
        if (!renderedContext && frame.renderedContext) {
          renderedContext = frame.renderedContext;
        }
        
        return {
          ...frame,
          renderedContext
        };
      });
      
      const metrics = this.tracker.getMetrics();
      const response: FrameListResponse = { frames: enrichedFrames, metrics };
      res.json(response);
    });
    
    this.app.get('/api/frames/:uuid', (req, res) => {
      const frame = this.tracker.getFrame(req.params.uuid);
      if (!frame) {
        res.status(404).json({ error: 'frame not found' });
        return;
      }
      
      const veilSnapshot = this.veilState.getStateAtSequence(frame.sequence);
      const facets = Array.from(veilSnapshot.facets.values());
      
      const activationFacet = (frame as any).deltas?.find((d: any) => 
        d.type === 'addFacet' && d.facet?.type === 'agent-activation'
      )?.facet;
      
      let renderedContext = null;
      if (activationFacet) {
        const contextFacet = facets.find(f => 
          f.type === 'rendered-context' && 
          (f as any).state?.activationId === activationFacet.id
        );
        renderedContext = contextFacet ? (contextFacet as any).state?.context : null;
      }
      
      if (!renderedContext && frame.renderedContext) {
        renderedContext = frame.renderedContext;
      }
      
      res.json({
        ...frame,
        renderedContext,
        veilState: {
          facets: facets.map(f => sanitizeFacetTreeNode(f)),
          sequence: veilSnapshot.sequence,
          facetCount: facets.length
        }
      });
    });

    this.app.get('/api/state', (_req, res) => {
      try {
        const components = this.space.components || [];

        // Serialize space structure with constraint-based component info
        const spaceInfo = {
          id: this.space.id,
          name: this.space.name,
          components: components.map(c => ({
            constructor: { name: c.constructor.name },
            name: c.constructor.name,
            id: c.id || 'unknown',
            constraints: c.getConstraintFacets(),
            enabled: c.enabled
          })),
          componentCount: components.length
        };

        res.json({
          space: spaceInfo,
          veil: serializeVEILState(this.veilState.getState()),
          metrics: this.tracker.getMetrics(),
          manualLLMEnabled: this.debugLLMEnabled,
          tracingEnabled: this.space.enableComponentTracing
        });
      } catch (error: any) {
        console.error('[DebugServer] Error serializing state:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Legacy route support - returns component if found
    this.app.get('/api/elements/:id', (req, res) => {
      const id = req.params.id;
      // Try to find component
      const component = this.space.getComponentById(id);
      
      if (!component) {
        res.status(404).json({ error: 'component/element not found' });
        return;
      }
      res.json(serializeComponent(component));
    });

    this.app.get('/api/facets', (_req, res) => {
      res.json(serializeVEILState(this.veilState.getState()));
    });

    this.app.post('/api/events', (req, res) => {
      const { topic, payload, sourceId } = req.body || {};
      if (!topic) {
        res.status(400).json({ error: 'topic is required' });
        return;
      }
      
      // Resolve source ref from ID (or default to space)
      let sourceRef: ComponentRef;
      if (sourceId) {
          const comp = this.space.getComponentById(sourceId);
          sourceRef = comp ? comp.getRef() : this.space.getRef();
      } else {
          sourceRef = this.space.getRef();
      }

      this.space.emit({
        topic,
        source: sourceRef,
        payload: payload || {},
        timestamp: Date.now()
      } as SpaceEvent);
      res.json({ status: 'ok' });
    });

    this.app.put('/api/elements/:id/props', (req, res) => {
      // Legacy compatibility: map element ID to component ID
      const id = req.params.id;
      const comp = this.space.getComponentById(id);
      
      if (!comp) {
        res.status(404).json({ error: 'component not found' });
        return;
      }
      
      const { props } = req.body || {};
      if (props && typeof props === 'object') {
        Object.entries(props).forEach(([key, value]) => {
          if (typeof (comp as any)[key] === 'function') {
            return;
          }
          (comp as any)[key] = value;
        });
      }
      res.json(serializeComponent(comp));
    });

    this.app.get('/api/debug-llm/requests', (_req, res) => {
      if (!debugLLMBridge.isEnabled()) {
        res.json({ enabled: false, requests: [] });
        return;
      }
      res.json({ enabled: true, requests: debugLLMBridge.getRequests() });
    });

    this.app.post('/api/debug-llm/requests/:id/complete', (req, res) => {
      if (!debugLLMBridge.isEnabled()) {
        res.status(503).json({ error: 'Debug LLM provider not enabled' });
        return;
      }
      const { id } = req.params;
      const { content, modelId, tokensUsed } = req.body || {};

      if (typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      let parsedTokens: number | undefined;
      if (tokensUsed !== undefined) {
        const numeric = typeof tokensUsed === 'number' ? tokensUsed : parseInt(String(tokensUsed), 10);
        if (!Number.isFinite(numeric) || numeric < 0) {
          res.status(400).json({ error: 'tokensUsed must be a non-negative number' });
          return;
        }
        parsedTokens = numeric;
      }

      const request = debugLLMBridge.completeRequest(id, {
        content: content.trim(),
        modelId: typeof modelId === 'string' && modelId.trim() ? modelId.trim() : undefined,
        tokensUsed: parsedTokens
      });

      if (!request) {
        res.status(404).json({ error: 'request not found or already resolved' });
        return;
      }

      res.json({ status: 'ok', request });
    });

    this.app.post('/api/config/tracing', (req, res) => {
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      this.space.toggleComponentTracing(enabled);
      res.json({ enabled: this.space.enableComponentTracing });
    });

    this.app.get('/api/metrics', (_req, res) => {
      res.json(this.tracker.getMetrics());
    });

    // Frame deletion endpoint
    this.app.post('/api/frames/delete', async (req, res) => {
      const { count } = req.body || {};
      
      if (!count || typeof count !== 'number' || count <= 0) {
        res.status(400).json({ error: 'count must be a positive number' });
        return;
      }
      
      try {
        // Check if we have a PersistenceMaintainer available
        const persistence = (this.space as any).persistence;
        if (!persistence) {
          res.status(503).json({ error: 'Persistence not available' });
          return;
        }
        
        // Get current state info before deletion
        const veilState = this.veilState.getState();
        const beforeCount = veilState.frameHistory.length;
        const beforeSequence = veilState.currentSequence;
        
        if (count > beforeCount) {
          res.status(400).json({ 
            error: `Cannot delete ${count} frames, only ${beforeCount} exist` 
          });
          return;
        }
        
        // Execute frame deletion using VEILStateManager with selective reinit
        const result = await this.veilState.deleteRecentFramesWithReinit(
          count,
          this.space
        );
        
        // Remove deleted frames from debug tracker
        const deletedSequences = result.deletedFrames.map(f => f.sequence);
        this.tracker.removeFramesBySequence(deletedSequences);
        
        // Save deletion record if we have persistence
        if (persistence) {
          try {
            // Create a new snapshot after deletion
            await persistence.createSnapshot();
          } catch (e) {
            console.warn('[DebugUI] Could not create deletion snapshot:', e);
          }
        }
        
        // Notify connected clients about the deletion
        this.broadcast({
          type: 'frame-deletion',
          payload: {
            deletedCount: count,
            beforeSequence,
            afterSequence: result.revertedSequence,
            deletedFrames: result.deletedFrames,
            warnings: result.warnings
          }
        });
        
        res.json({
          success: true,
          deletedCount: count,
          deletedFrames: result.deletedFrames,
          revertedToSequence: result.revertedSequence,
          warnings: result.warnings || []
        });
        
      } catch (error: any) {
        console.error('[DebugUI] Frame deletion failed:', error);
        res.status(500).json({ 
          error: 'Frame deletion failed', 
          details: error.message 
        });
      }
    });
  }

  private setupWebSocket(): void {
    this.wsServer.on('connection', socket => {
      socket.send(JSON.stringify({
        type: 'hello',
        payload: {
          frames: [], // Let HTTP API handle initial frame loading with proper pagination
          state: serializeVEILState(this.veilState.getState()),
          metrics: this.tracker.getMetrics(),
          manualLLMEnabled: this.debugLLMEnabled,
          debugLLMRequests: this.debugLLMEnabled ? debugLLMBridge.getRequests() : []
        }
      }));

      socket.on('message', data => {
        try {
          const message = JSON.parse(String(data));
          if (message.type === 'pauseUpdates') {
            // Client side throttling - no server state needed yet
          }
        } catch (err) {
          console.warn('Debug socket message parsing failed', err);
        }
      });
    });
  }

  private setupStaticAssets(): void {
    const candidates = [
      path.resolve(__dirname, '..', '..', 'debug-ui'),
      path.resolve(process.cwd(), 'debug-ui'),
      path.resolve(process.cwd(), 'dist', 'debug-ui')
    ];

    const uiPath = candidates.find(candidate => fs.existsSync(candidate));

    if (!uiPath) {
      console.warn('[DebugServer] No debug-ui directory found. UI assets will not be served.');
      return;
    }

    // Serve UI static files from /ui/* to avoid catching API routes
    this.app.use('/ui', express.static(uiPath));
    
    this.app.get('/', (_req, res) => {
      const indexPath = path.join(uiPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.send('<html><body><h1>Connectome Debug Server</h1><p>API available at /api/*</p><p>UI files not found</p></body></html>');
      }
    });
    
    // Add 404 handler for unmatched routes (after all other routes)
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found', path: req.path });
    });
  }

  private broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of this.wsServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
