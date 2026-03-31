import {
  Facet,
  VEILState,
  VEILOperation,
  StreamRef,
  StreamInfo,
  FrameTransition,
  Frame
} from './types';
import { FacetDelta } from '../spaces/receptor-effector-types';
import { Space } from '../spaces/space';
import { Component } from '../spaces/component';
import { isForkInvariant } from '../spaces/types';
import { getPersistenceMetadata } from '../persistence/decorators';

/**
 * Snapshot of VEIL state at a specific sequence
 */
export interface VEILStateSnapshot {
  sequence: number;
  facets: Map<string, Facet>;
  removals: Map<string, 'hide' | 'delete'>;
}

/**
 * Manages the current VEIL state by applying frame deltas
 */
export class VEILStateManager {
  private state: VEILState;
  private listeners: Array<(state: VEILState) => void> = [];

  // Cache for historical state snapshots (for efficient time-travel queries)
  private historicalStateCache: Map<number, VEILStateSnapshot> = new Map();
  private readonly maxCachedSnapshots = 10;

  // Frame history limit (0 = unlimited for backward compat)
  private maxFrameHistory: number = 0;

  // Per-stream minimum conversation frame retention (0 = disabled)
  private minFramesPerStream: number = 0;

  // Running count of conversation frames per stream (for O(1) protection checks)
  private streamConversationFrameCounts: Map<string, number> = new Map();

  constructor() {
    this.state = {
      facets: new Map(),
      scopes: new Set(),
      streams: new Map(),
      agents: new Map(),
      currentStream: undefined,
      currentAgent: undefined,
      frameHistory: [],
      currentSequence: 0,
      removals: new Map(),
      currentStateCache: new Map()
    };
  }

  /**
   * Set the maximum number of frames to keep in history.
   * When exceeded, oldest frames are trimmed.
   * @param limit Max frames to keep (0 = unlimited)
   */
  setMaxFrameHistory(limit: number): void {
    this.maxFrameHistory = limit;
    if (limit > 0) {
      this.trimFrameHistory();
    }
  }

  /** Facet types that are conversation-bound (cleaned up when their frame is trimmed) */
  private static readonly CONVERSATION_FACET_TYPES = new Set([
    'event', 'speech', 'thought', 'action',
    'tool-call', 'script-execution', 'action-definition',
    'agent-activation', 'rendered-context',
  ]);

  /** Facet types that represent actual visible messages (for per-stream retention counting).
   *  Excludes agent-activation/rendered-context which are ephemeral infrastructure —
   *  they outnumber real messages ~20:1 and would make minFramesPerStream meaningless. */
  private static readonly MESSAGE_FACET_TYPES = new Set([
    'event', 'speech', 'thought', 'action',
  ]);

  /**
   * Set the minimum number of message-bearing frames to retain per stream.
   * When trimming, frames that would drop a stream below this threshold are protected.
   * @param min Minimum message frames per stream (0 = disabled)
   */
  setMinFramesPerStream(min: number): void {
    this.minFramesPerStream = min;
  }

  /**
   * Rebuild the running stream conversation frame counts from current frame history.
   * Called after snapshot restore when the counts need to be reconstructed.
   */
  rebuildStreamConversationCounts(): void {
    this.streamConversationFrameCounts.clear();
    for (const frame of this.state.frameHistory) {
      this.trackFrameForStreamCounts(frame);
    }
    if (this.streamConversationFrameCounts.size > 0) {
      const totalMessages = [...this.streamConversationFrameCounts.values()].reduce((a, b) => a + b, 0);
      const belowMin = this.minFramesPerStream > 0
        ? [...this.streamConversationFrameCounts.values()].filter(c => c <= this.minFramesPerStream).length
        : 0;
      console.log(`[VEILState] Rebuilt message counts: ${this.streamConversationFrameCounts.size} streams with messages (${totalMessages} total), ${belowMin} at or below min ${this.minFramesPerStream}`);
    }
  }

  /**
   * Check if a frame has at least one message-bearing addFacet delta (event, speech, thought, action).
   * Excludes agent-activation/rendered-context which are ephemeral infrastructure.
   */
  private isMessageFrame(frame: Frame): boolean {
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet &&
          VEILStateManager.MESSAGE_FACET_TYPES.has(delta.facet.type)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update the running stream conversation frame counter after a frame is added.
   */
  private trackFrameForStreamCounts(frame: Frame): void {
    const streamId = frame.activeStream?.streamId;
    if (!streamId) return;
    if (this.isMessageFrame(frame)) {
      this.streamConversationFrameCounts.set(
        streamId,
        (this.streamConversationFrameCounts.get(streamId) || 0) + 1
      );
    }
  }

  /**
   * Decrement stream conversation frame count when evicting a frame.
   */
  private untrackFrameForStreamCounts(frame: Frame): void {
    const streamId = frame.activeStream?.streamId;
    if (!streamId) return;
    if (this.isMessageFrame(frame)) {
      const current = this.streamConversationFrameCounts.get(streamId) || 0;
      if (current <= 1) {
        this.streamConversationFrameCounts.delete(streamId);
      } else {
        this.streamConversationFrameCounts.set(streamId, current - 1);
      }
    }
  }

  /**
   * Trim frame history to maxFrameHistory limit with per-stream minimum retention.
   *
   * When minFramesPerStream > 0, frames in the eviction zone are protected if
   * evicting them would drop their stream below the minimum conversation frame count.
   * A hard cap of 1.5x maxFrameHistory prevents unbounded growth.
   *
   * State/ambient/config facets persist independently of frame history.
   */
  private trimFrameHistory(): void {
    if (this.maxFrameHistory <= 0) return;

    const totalFrames = this.state.frameHistory.length;
    const excess = totalFrames - this.maxFrameHistory;
    if (excess <= 0) return;

    // Fast path: no per-stream protection
    if (this.minFramesPerStream <= 0) {
      this.evictOldestFrames(excess);
      return;
    }

    // Per-stream protection: walk candidate eviction zone and protect frames
    // whose eviction would drop their stream below the minimum.
    // Use running counts (O(1) per stream lookup) to decide protection.
    const protectedIndices = new Set<number>();
    const simulatedCounts = new Map(this.streamConversationFrameCounts);

    for (let i = 0; i < excess; i++) {
      const frame = this.state.frameHistory[i];
      const streamId = frame.activeStream?.streamId;
      if (!streamId) continue; // Ambient frames never protected

      if (!this.isMessageFrame(frame)) continue;

      const remaining = simulatedCounts.get(streamId) || 0;
      if (remaining <= this.minFramesPerStream) {
        protectedIndices.add(i);
      } else {
        simulatedCounts.set(streamId, remaining - 1);
      }
    }

    // Hard cap: 1.5x maxFrameHistory — prevent unbounded growth from many streams
    const hardCap = Math.floor(this.maxFrameHistory * 1.5);
    const projectedSize = totalFrames - excess + protectedIndices.size;

    if (projectedSize > hardCap) {
      // Unprotect from streams with the most remaining frames first
      const protectedByStream = new Map<string, number[]>();
      for (const idx of protectedIndices) {
        const sid = this.state.frameHistory[idx].activeStream!.streamId;
        if (!protectedByStream.has(sid)) protectedByStream.set(sid, []);
        protectedByStream.get(sid)!.push(idx);
      }

      const sortedStreams = [...protectedByStream.entries()]
        .sort((a, b) => (simulatedCounts.get(b[0]) || 0) - (simulatedCounts.get(a[0]) || 0));

      let toUnprotect = projectedSize - hardCap;
      for (const [, indices] of sortedStreams) {
        if (toUnprotect <= 0) break;
        indices.sort((a, b) => a - b); // oldest first
        for (const idx of indices) {
          if (toUnprotect <= 0) break;
          protectedIndices.delete(idx);
          toUnprotect--;
        }
      }
    }

    if (protectedIndices.size === 0) {
      this.evictOldestFrames(excess);
      return;
    }

    // Build new frame history: protected + retained
    const evictedFrames: Frame[] = [];
    const newHistory: Frame[] = [];

    for (let i = 0; i < excess; i++) {
      if (protectedIndices.has(i)) {
        newHistory.push(this.state.frameHistory[i]);
      } else {
        const frame = this.state.frameHistory[i];
        evictedFrames.push(frame);
        this.untrackFrameForStreamCounts(frame);
      }
    }

    for (let i = excess; i < totalFrames; i++) {
      newHistory.push(this.state.frameHistory[i]);
    }

    this.state.frameHistory = newHistory;
    this.cleanupEvictedFrameFacets(evictedFrames);
    this.cleanupHistoricalCache();

    console.log(`[VEILState] Trimmed ${evictedFrames.length} frames, protected ${protectedIndices.size} per-stream (retained ${this.state.frameHistory.length} frames, ${this.state.facets.size} facets, limit ${this.maxFrameHistory}, min/stream ${this.minFramesPerStream})`);
  }

  /**
   * Fast-path eviction: remove the oldest `count` frames with no per-stream protection.
   */
  private evictOldestFrames(count: number): void {
    const evictedFrames = this.state.frameHistory.slice(0, count);
    this.state.frameHistory = this.state.frameHistory.slice(count);

    for (const frame of evictedFrames) {
      this.untrackFrameForStreamCounts(frame);
    }

    this.cleanupEvictedFrameFacets(evictedFrames);
    this.cleanupHistoricalCache();

    const cleanedFacets = 0; // logged inside cleanupEvictedFrameFacets
    console.log(`[VEILState] Trimmed ${count} frames (retained ${this.state.frameHistory.length} frames, ${this.state.facets.size} facets, limit ${this.maxFrameHistory})`);
  }

  /**
   * Clean up conversation facets introduced by evicted frames.
   * Facets still referenced by retained frames are preserved.
   */
  private cleanupEvictedFrameFacets(evictedFrames: Frame[]): void {
    const evictedFacetIds = new Set<string>();
    for (const frame of evictedFrames) {
      for (const delta of frame.deltas || []) {
        if (delta.type === 'addFacet' && delta.facet?.id) {
          evictedFacetIds.add(delta.facet.id);
        }
      }
    }

    const retainedFacetIds = new Set<string>();
    for (const frame of this.state.frameHistory) {
      for (const delta of frame.deltas || []) {
        if (delta.type === 'addFacet' && delta.facet?.id) {
          retainedFacetIds.add(delta.facet.id);
        } else if (delta.type === 'rewriteFacet' && delta.id) {
          retainedFacetIds.add(delta.id);
        }
      }
    }

    for (const facetId of evictedFacetIds) {
      if (retainedFacetIds.has(facetId)) continue;
      const facet = this.state.facets.get(facetId);
      if (!facet) continue;
      if (!VEILStateManager.CONVERSATION_FACET_TYPES.has(facet.type)) continue;
      this.state.facets.delete(facetId);
      this.state.currentStateCache.delete(facetId);
      this.state.removals.delete(facetId);
    }
  }

  /**
   * Clean up historicalStateCache for sequences no longer in frame history.
   */
  private cleanupHistoricalCache(): void {
    if (this.historicalStateCache.size === 0) return;
    const minRetainedSequence = this.state.frameHistory.length > 0
      ? this.state.frameHistory[0].sequence
      : Infinity;
    for (const seq of this.historicalStateCache.keys()) {
      if (seq < minRetainedSequence) {
        this.historicalStateCache.delete(seq);
      }
    }
  }

  /**
   * One-time cleanup of orphaned conversation facets after restore.
   * Removes conversation facets from state.facets that aren't referenced
   * by any retained frame's deltas. These are leftovers from before
   * trimFrameHistory() started cleaning up facets.
   */
  purgeOrphanedFacets(): void {
    // Collect all facet IDs referenced by retained frames
    const referencedIds = new Set<string>();
    for (const frame of this.state.frameHistory) {
      for (const delta of frame.deltas || []) {
        if (delta.type === 'addFacet' && delta.facet?.id) {
          referencedIds.add(delta.facet.id);
        } else if (delta.type === 'rewriteFacet' && delta.id) {
          referencedIds.add(delta.id);
        } else if (delta.type === 'removeFacet' && delta.id) {
          referencedIds.add(delta.id);
        }
      }
    }

    let purged = 0;
    for (const [id, facet] of this.state.facets) {
      if (referencedIds.has(id)) continue;
      if (!VEILStateManager.CONVERSATION_FACET_TYPES.has(facet.type)) continue;

      this.state.facets.delete(id);
      this.state.currentStateCache.delete(id);
      this.state.removals.delete(id);
      purged++;
    }

    if (purged > 0) {
      console.log(`[VEILState] Purged ${purged} orphaned conversation facets (${this.state.facets.size} remaining)`);
    }
  }

  /**
   * Get the next sequence number for a new frame
   */
  getNextSequence(): number {
    return this.state.currentSequence + 1;
  }

  /**
   * Atomically allocate the next sequence and apply a frame.
   * Prevents race conditions where getNextSequence() is called but applyFrame()
   * fails or another caller interleaves between the two calls.
   *
   * @param buildFrame - Callback that receives the allocated sequence and returns the frame to apply
   * @param skipEphemeralCleanup - If true, skip ephemeral facet cleanup
   * @returns The applied frame's changes, or empty array if the frame could not be applied
   */
  allocateAndApplyFrame(
    buildFrame: (sequence: number, timestamp: string) => Frame,
    skipEphemeralCleanup: boolean = false
  ): FacetDelta[] {
    const sequence = this.state.currentSequence + 1;
    const timestamp = new Date().toISOString();
    const frame = buildFrame(sequence, timestamp);
    return this.applyFrame(frame, skipEphemeralCleanup);
  }

  /**
   * Get the current sequence number (last committed frame)
   */
  getCurrentSequence(): number {
    return this.state.currentSequence;
  }

  /**
   * Register a stream in VEIL state (called on stream creation).
   * Idempotent: if the stream already exists, merges new metadata and
   * appends the caller to the participants list instead of overwriting.
   * @returns `{ created: true }` for new streams, `{ created: false }` for joins
   */
  registerStream(info: StreamInfo): { created: boolean } {
    const existing = this.state.streams.get(info.id);
    if (existing) {
      // Merge metadata (new keys win, but don't clobber existing ones that aren't in the new set)
      if (info.metadata) {
        existing.metadata = { ...existing.metadata, ...info.metadata };
      }
      // Update parentId if a new one is provided (substream reused from different context)
      if (info.parentId) {
        existing.parentId = info.parentId;
      }
      // Ensure participants array exists and append the new creator
      if (!existing.participants) {
        existing.participants = [];
      }
      const newParticipant = info.metadata?.createdBy as string | undefined;
      if (newParticipant && !existing.participants.includes(newParticipant)) {
        existing.participants.push(newParticipant);
      }
      return { created: false };
    }
    // New stream — seed participants from createdBy if present
    if (!info.participants) {
      info.participants = [];
    }
    const creator = info.metadata?.createdBy as string | undefined;
    if (creator && !info.participants.includes(creator)) {
      info.participants.push(creator);
    }
    this.state.streams.set(info.id, info);
    return { created: true };
  }

  /**
   * Get parentage info for a stream (parent ID and fork sequence)
   */
  getStreamParentage(streamId: string): { parentId: string; forkSequence: number } | null {
    const stream = this.state.streams.get(streamId);
    if (!stream?.parentId || stream.forkSequence == null) return null;
    return { parentId: stream.parentId, forkSequence: stream.forkSequence };
  }

  /**
   * Apply a frame and return the changes
   */
  applyFrame(frame: Frame, skipEphemeralCleanup: boolean = false): FacetDelta[] {
    // Validate sequence - must be exactly the next number
    const expectedSequence = this.state.currentSequence + 1;
    if (frame.sequence !== expectedSequence) {
      throw new Error(
        `Frame sequence error: expected ${expectedSequence}, got ${frame.sequence} ` +
        `(current: ${this.state.currentSequence})`
      );
    }

    const changes: FacetDelta[] = [];

    // Update active stream if provided
    if (frame.activeStream !== undefined) {
      this.state.currentStream = frame.activeStream;
    }

    // Process each operation and track changes
    for (const delta of frame.deltas) {
      const change = this.applyDelta(delta, frame.sequence, frame.timestamp);
      if (change) {
        changes.push(change);
      }
    }

    // Freeze frame to ensure immutability (enables safe reference sharing)
    Object.freeze(frame);
    Object.freeze(frame.deltas);  // Also freeze the deltas array
    
    // Update state
    this.state.frameHistory.push(frame);
    this.state.currentSequence = frame.sequence;
    this.trackFrameForStreamCounts(frame);
    this.trimFrameHistory();

    // Remove ephemeral facets at end of frame (unless skipped)
    if (!skipEphemeralCleanup) {
      const ephemeralFacets: Array<[string, Facet]> = [];
      for (const [id, facet] of this.state.facets) {
        if ('ephemeral' in facet && facet.ephemeral === true) {
          ephemeralFacets.push([id, facet]);
        }
      }

      // Remove ephemeral facets
      for (const [id, facet] of ephemeralFacets) {
        this.state.facets.delete(id);
        // Also track this as a removal for the frame
        changes.push({
          type: 'removed',
          facet
        });
      }
    }

    // Notify listeners
    this.notifyListeners();

    return changes;
  }

  /**
   * Apply deltas directly to state without creating a frame
   * Used during component execution where changes should be immediately visible
   * but we don't want to create intermediate frames in history
   */
  applyDeltasDirect(deltas: VEILOperation[]): FacetDelta[] {
    const changes: FacetDelta[] = [];
    
    for (const delta of deltas) {
      const change = this.applyDelta(delta);
      if (change) {
        changes.push(change);
      }
    }
    
    // Do NOT notify listeners - that happens after full frame completes
    // Do NOT update sequence or frame history
    
    return changes;
  }
  
  /**
   * Finalize a frame by adding it to history and updating sequence
   * Used when deltas have already been applied via applyDeltasDirect
   */
  finalizeFrame(frame: Frame, skipEphemeralCleanup: boolean = false): void {
    // Validate sequence - must be exactly the next number
    const expectedSequence = this.state.currentSequence + 1;
    if (frame.sequence !== expectedSequence) {
      throw new Error(
        `Frame sequence error: expected ${expectedSequence}, got ${frame.sequence} ` +
        `(current: ${this.state.currentSequence})`
      );
    }
    
    // Update active stream if provided
    if (frame.activeStream !== undefined) {
      this.state.currentStream = frame.activeStream;
    }
    
    // Freeze frame to ensure immutability (enables safe reference sharing)
    Object.freeze(frame);
    Object.freeze(frame.deltas);  // Also freeze the deltas array

    // Update state
    this.state.frameHistory.push(frame);
    this.state.currentSequence = frame.sequence;
    this.trackFrameForStreamCounts(frame);
    this.trimFrameHistory();

    // Remove ephemeral facets at end of frame (unless skipped)
    if (!skipEphemeralCleanup) {
      const ephemeralFacets: Array<[string, Facet]> = [];
      for (const [id, facet] of this.state.facets) {
        if ('ephemeral' in facet && facet.ephemeral === true) {
          ephemeralFacets.push([id, facet]);
        }
      }

      // Remove ephemeral facets
      for (const [id, facet] of ephemeralFacets) {
        this.state.facets.delete(id);
      }
    }

    // Notify listeners
    this.notifyListeners();
  }
  
  /**
   * Clean up ephemeral facets - call this at the end of full frame processing
   */
  cleanupEphemeralFacets(): FacetDelta[] {
    const changes: FacetDelta[] = [];
    const ephemeralFacets: Array<[string, Facet]> = [];
    
    for (const [id, facet] of this.state.facets) {
      if ('ephemeral' in facet && facet.ephemeral === true) {
        ephemeralFacets.push([id, facet]);
      }
    }
    
    // Remove ephemeral facets
    for (const [id, facet] of ephemeralFacets) {
      this.state.facets.delete(id);
      changes.push({
        type: 'removed',
        facet
      });
    }
    
    if (changes.length > 0) {
      this.notifyListeners();
    }
    
    return changes;
  }
  
  applyDelta(operation: VEILOperation, frameSequence?: number, timestamp?: string): FacetDelta | null {
    switch (operation.type) {
      case 'addFacet': {
        // Validate facet structure
        this.validateFacetStructure(operation.facet);

        const cloned = this.cloneFacet(operation.facet);
        this.state.facets.set(cloned.id, cloned);
        // Children stay nested in cloned.children - no flattening to top-level

        // Update cache for state facets (clone to avoid shared references)
        if (cloned.type === 'state' && 'state' in cloned) {
          this.state.currentStateCache.set(cloned.id, JSON.parse(JSON.stringify(cloned.state)));
        }

        // Update agents registry for agent-registry facets
        if (cloned.type === 'agent-registry' && 'state' in cloned) {
          const agentState = (cloned as any).state;
          if (agentState.agentId && agentState.agentInfo) {
            this.state.agents.set(agentState.agentId, agentState.agentInfo);
          }
        }

        // Process state-change facets to update cache
        // This may create new internal-state facets, which we need to track
        let delta: FacetDelta = { type: 'added', facet: cloned };

        if (cloned.type === 'state-change' && (cloned as any).targetFacetIds) {
          const newFacetDeltas = this.applyStateChangesToCache(cloned as any);
          // Note: newFacetDeltas are returned but caller needs to handle them
          // For now, we return the state-change delta, new facets are side effects
          // TODO: Return multiple deltas or queue new facets for next frame
        }

        return delta;
      }
      case 'rewriteFacet': { // Exotemporal: rewrite existing facet
        const existing = this.state.facets.get(operation.id);
        if (!existing || !operation.changes) {
          return null;
        }

        const updated = this.cloneFacet(existing);

        // Handle content if present
        if ('content' in operation.changes && operation.changes.content !== undefined) {
          (updated as any).content = operation.changes.content;
        }

        // Handle state if present
        if ('state' in operation.changes && operation.changes.state) {
          const previousState = this.isPlainObject((updated as any).state)
            ? (updated as any).state
            : {};
          (updated as any).state = this.deepMergeObjects(
            previousState,
            operation.changes.state as Record<string, any>
          );
        }

        // Handle other fields - deep merge plain objects, direct assign everything else
        for (const [key, value] of Object.entries(operation.changes)) {
          if (key === 'state' || key === 'content' || value === undefined) {
            continue;
          }

          const existingValue = (updated as any)[key];
          if (this.isPlainObject(existingValue) && this.isPlainObject(value)) {
            // Deep merge plain objects
            (updated as any)[key] = this.deepMergeObjects(existingValue, value as Record<string, any>);
          } else {
            // Direct assignment for arrays, primitives, and other non-object types
            (updated as any)[key] = value;
          }
        }

        // Handle aspect fields
        const aspectKeys = ['agentId', 'agentName', 'streamId', 'streamType', 'scopes'];
        for (const key of aspectKeys) {
          if (key in operation.changes && (operation.changes as any)[key] !== undefined) {
            (updated as any)[key] = (operation.changes as any)[key];
          }
        }

        // Don't clone again - we already preserved what we need
        this.state.facets.set(operation.id, updated);
        
        // Update cache if this is a state facet (clone to avoid shared references)
        if (updated.type === 'state' && 'state' in updated) {
          this.state.currentStateCache.set(operation.id, JSON.parse(JSON.stringify(updated.state)));
        }
        
        return { type: 'changed', facet: updated, oldFacet: existing };
      }
      case 'removeFacet': {
        const existing = this.state.facets.get(operation.id);
        if (!existing) {
          return null;
        }
        this.state.facets.delete(operation.id);

        // Remove from cache if it's a state facet
        if (existing.type === 'state') {
          this.state.currentStateCache.delete(operation.id);
        }

        // Remove from agents registry for agent-registry facets
        if (existing.type === 'agent-registry' && 'state' in existing) {
          const agentState = (existing as any).state;
          if (agentState.agentId) {
            this.state.agents.delete(agentState.agentId);
          }
        }

        return { type: 'removed', facet: existing };
      }
      default:
        return null;
    }
  }

  /**
   * Validate facet structure matches type definition
   */
  private validateFacetStructure(facet: Facet): void {
    switch (facet.type) {
      case 'event':
        if (!(facet as any).state?.eventType) {
          console.error(`[VEIL] Invalid EventFacet structure for ${facet.id}:`, facet);
          throw new Error(
            `EventFacet must have state.eventType, got: ${JSON.stringify(facet)}. ` +
            `Use createEventFacet() helper or set state: { source, eventType, metadata }`
          );
        }
        break;
      
      case 'state':
        if (!('state' in facet)) {
          throw new Error(`StateFacet ${facet.id} must have state field`);
        }
        break;
        
      case 'speech':
      case 'thought':
      case 'action':
        // Agent-generated facets should have agentId
        if (!(facet as any).agentId) {
          console.warn(`[VEIL] ${facet.type} facet ${facet.id} missing agentId`);
        }
        break;
    }
  }

  /**
   * Apply state-change facet to cache
   * Handles both existing facets and creates new cache entries for missing facets
   * Returns deltas for any newly created internal-state facets
   */
  private applyStateChangesToCache(stateChangeFacet: any): FacetDelta[] {
    const { targetFacetIds, state: changeState } = stateChangeFacet;
    const newFacetDeltas: FacetDelta[] = [];
    
    if (!targetFacetIds || !changeState?.changes) return newFacetDeltas;
    
    for (const targetId of targetFacetIds) {
      // Get or create cached state
      const existingCache = this.state.currentStateCache.get(targetId);
      const targetFacet = this.state.facets.get(targetId);
      
      // Clone the cached state to avoid mutating original facets
      const cachedState = JSON.parse(JSON.stringify(
        existingCache || 
        (targetFacet && 'state' in targetFacet ? targetFacet.state : {}) ||
        {}
      ));
      
      // Apply each change
      for (const [key, change] of Object.entries(changeState.changes)) {
        if (change && typeof change === 'object' && 'new' in change) {
          cachedState[key] = (change as any).new;
        }
      }
      
      this.state.currentStateCache.set(targetId, cachedState);
      
      // If target facet doesn't exist, create it
      // This enables "update-or-create" semantics
      if (!targetFacet) {
        const newFacet = {
          id: targetId,
          type: 'internal-state',
          state: cachedState
        };
        this.state.facets.set(targetId, newFacet);
        
        // Return delta so it gets tracked and persisted
        newFacetDeltas.push({ type: 'added', facet: newFacet });
      }
    }
    
    return newFacetDeltas;
  }

  /**
   * Get current state for a state facet (O(1) cached lookup)
   */
  getCurrentStateFor(facetId: string): any {
    return this.state.currentStateCache.get(facetId) || {};
  }

  /**
   * Rebuild state cache from all facets and state-changes
   * Called after restoration to reconstruct the cache
   */
  rebuildStateCache(): void {
    this.state.currentStateCache.clear();
    
    // First, cache all initial state facets (clone to avoid shared references)
    for (const [id, facet] of this.state.facets) {
      if (facet.type === 'state' && 'state' in facet) {
        this.state.currentStateCache.set(id, JSON.parse(JSON.stringify(facet.state)));
      }
    }
    
    // Then apply all state-changes in order (by facet ID which includes timestamp)
    const stateChanges = Array.from(this.state.facets.values())
      .filter(f => f.type === 'state-change')
      .sort((a, b) => a.id.localeCompare(b.id)); // Chronological order
    
    for (const stateChange of stateChanges) {
      this.applyStateChangesToCache(stateChange as any);
    }
  }

  /**
   * Get current state snapshot
   */
  getState(): Readonly<VEILState> {
    return {
      facets: new Map(this.state.facets),
      scopes: new Set(this.state.scopes),
      streams: new Map(this.state.streams),
      agents: new Map(this.state.agents),
      currentStream: this.state.currentStream,
      currentAgent: this.state.currentAgent,
      frameHistory: [...this.state.frameHistory],
      currentSequence: this.state.currentSequence,
      removals: new Map(this.state.removals),
      currentStateCache: new Map(this.state.currentStateCache)
    };
  }

  /**
   * Get VEIL state as it existed at a specific frame sequence
   * This is the single source of truth for historical state queries
   * Cached for efficiency - repeated queries are O(1) after first call
   * 
   * @param targetSequence - The frame sequence to get state for (1-indexed)
   * @param compressionEngine - Optional compression engine for state delta shortcuts
   * @returns Snapshot of facets and removals at that sequence
   */
  getStateAtSequence(targetSequence: number, compressionEngine?: any): VEILStateSnapshot {
    // If requesting current state, return live state
    if (targetSequence === this.state.currentSequence) {
      return {
        sequence: targetSequence,
        facets: new Map(this.state.facets),
        removals: new Map(this.state.removals)
      };
    }
    
    // Allow querying currentSequence + 1 (for in-progress frames)
    // Return current state since the frame hasn't been finalized yet
    if (targetSequence === this.state.currentSequence + 1) {
      return {
        sequence: targetSequence,
        facets: new Map(this.state.facets),
        removals: new Map(this.state.removals)
      };
    }
    
    // Validate sequence
    if (targetSequence < 0 || targetSequence > this.state.currentSequence + 1) {
      throw new Error(`Invalid sequence ${targetSequence}. Current: ${this.state.currentSequence}`);
    }
    
    // Check cache
    if (this.historicalStateCache.has(targetSequence)) {
      return this.historicalStateCache.get(targetSequence)!;
    }
    
    // Find nearest cached snapshot before target
    const cachedSequences = Array.from(this.historicalStateCache.keys())
      .filter(seq => seq < targetSequence)
      .sort((a, b) => b - a); // Descending - nearest first
    
    let facets: Map<string, Facet>;
    let removals: Map<string, 'hide' | 'delete'>;
    let startFrom: number;
    
    if (cachedSequences.length > 0) {
      // Start from cached snapshot
      const nearestSeq = cachedSequences[0];
      const snapshot = this.historicalStateCache.get(nearestSeq)!;
      facets = new Map(snapshot.facets);
      removals = new Map(snapshot.removals);
      startFrom = nearestSeq + 1;
    } else {
      // Start from empty
      facets = new Map();
      removals = new Map();
      startFrom = 1;
    }
    
    // Get frames to replay
    const framesToReplay = this.state.frameHistory.filter(
      f => f.sequence >= startFrom && f.sequence <= targetSequence
    );
    
    // Replay frames, using compression shortcuts when available
    for (const frame of framesToReplay) {
      // Check if this frame is part of a compressed range
      if (compressionEngine?.shouldReplaceFrame(frame.sequence)) {
        const stateDelta = compressionEngine.getStateDelta(frame.sequence);
        
        if (stateDelta) {
          // Fast-forward using compression's state delta
          // Handle deletions
          for (const deletedId of stateDelta.deleted) {
            facets.delete(deletedId);
            removals.set(deletedId, 'delete');
          }
          
          // Apply changes
          for (const [facetId, changes] of stateDelta.changes) {
            const existing = facets.get(facetId);
            if (existing) {
              const updated = this.mergeFacetChanges(existing, changes);
              facets.set(facetId, updated);
            }
          }
          
          // Skip frames that return empty replacement (not first in range)
          const replacement = compressionEngine.getReplacement(frame.sequence);
          if (replacement === '') {
            continue; // Skip this frame
          }
        }
      }
      
      // Apply frame deltas normally
      for (const delta of frame.deltas) {
        this.applyDeltaToSnapshot(delta, facets, removals);
      }
    }
    
    // Cache the result
    const snapshot: VEILStateSnapshot = {
      sequence: targetSequence,
      facets,
      removals
    };
    
    this.historicalStateCache.set(targetSequence, snapshot);
    
    // Evict old cache entries (LRU - keep last N)
    if (this.historicalStateCache.size > this.maxCachedSnapshots) {
      const oldest = Array.from(this.historicalStateCache.keys())
        .sort((a, b) => a - b)[0];
      this.historicalStateCache.delete(oldest);
    }
    
    return snapshot;
  }

  /**
   * Get frame history as a direct readonly reference (zero-copy).
   * Frames are Object.freeze()'d, so safe to share without copying.
   */
  getFrameHistory(): readonly Frame[] {
    return this.state.frameHistory;
  }

  /**
   * Get facets map as a direct readonly reference (zero-copy).
   */
  getFacets(): ReadonlyMap<string, Facet> {
    return this.state.facets;
  }

  /**
   * @deprecated Use getState() instead
   * Alias for backward compatibility
   */
  getCurrentState(): Readonly<VEILState> {
    console.warn('getCurrentState() is deprecated. Use getState() instead.');
    return this.getState();
  }

  /**
   * Get active facets (filtered by scope)
   */
  getActiveFacets(): Map<string, Facet> {
    const active = new Map<string, Facet>();
    
    for (const [id, facet] of this.state.facets) {
      // Skip removed facets
      if (this.state.removals.has(id)) {
        continue;
      }
      
      // Check if facet is in scope
      if (!facet.scope || facet.scope.length === 0) {
        // No scope requirements - always active
        active.set(id, facet);
      } else if (facet.scope.some(s => this.state.scopes.has(s))) {
        // At least one required scope is active
        active.set(id, facet);
      }
    }

    return active;
  }

  /**
   * Clean up deleted facets from memory
   * This should be called periodically or before creating snapshots
   */
  cleanupDeletedFacets(): number {
    let cleaned = 0;
    for (const [id, mode] of this.state.removals) {
      if (mode === 'delete') {
        // Remove from facets map
        if (this.state.facets.delete(id)) {
          cleaned++;
        }
        // Remove from removals map
        this.state.removals.delete(id);
      }
    }
    return cleaned;
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: VEILState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }
  
  /**
   * Restore state from a snapshot (used by persistence system)
   */
  setState(newState: VEILState): void {
    this.state = {
      facets: new Map(newState.facets),
      scopes: new Set(newState.scopes),
      streams: new Map(newState.streams),
      agents: new Map(newState.agents || []),
      currentStream: newState.currentStream,
      currentAgent: newState.currentAgent,
      frameHistory: [...newState.frameHistory],
      currentSequence: newState.currentSequence,
      removals: new Map(newState.removals || []),
      currentStateCache: new Map(newState.currentStateCache || [])
    };
    this.notifyListeners();
  }

  /**
   * Get the current focus
   */
  getCurrentStream(): StreamRef | undefined {
    return this.state.currentStream;
  }

  /**
   * Get current streams
   */
  getStreams(): Map<string, import('./types').StreamInfo> {
    return new Map(this.state.streams);
  }

  private cloneFacet<T extends Facet>(facet: T): T {
    return JSON.parse(JSON.stringify(facet)) as T;
  }

  private deepMergeObjects<T extends Record<string, any>>(
    target: Record<string, any> | undefined,
    source: Record<string, any>
  ): T {
    const base: Record<string, any> = this.isPlainObject(target) ? { ...target } : {};

    for (const [key, incoming] of Object.entries(source)) {
      if (incoming === undefined) {
        continue;
      }

      if (Array.isArray(incoming)) {
        base[key] = this.cloneArray(incoming);
        continue;
      }

      if (this.isPlainObject(incoming)) {
        const existingValue = this.isPlainObject(base[key]) ? base[key] : undefined;
        base[key] = this.deepMergeObjects(existingValue, incoming);
        continue;
      }

      base[key] = incoming;
    }

    return base as T;
  }

  private cloneArray(values: any[]): any[] {
    return values.map(item => {
      if (this.isPlainObject(item)) {
        return this.deepMergeObjects(undefined, item as Record<string, any>);
      }
      if (Array.isArray(item)) {
        return this.cloneArray(item);
      }
      return item;
    });
  }

  private isPlainObject(value: unknown): value is Record<string, any> {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private notifyListeners(): void {
    const state = this.getState();
    const listeners = [...this.listeners];
    queueMicrotask(() => {
      const start = performance.now();
      for (const listener of listeners) {
        try {
          listener(state);
        } catch (error: any) {
          console.error(`[VEILState] Listener error: ${error.message}`);
        }
      }
      const elapsed = performance.now() - start;
      if (elapsed > 100) {
        console.warn(`[VEILState] Slow listener notification: ${elapsed.toFixed(1)}ms for ${listeners.length} listeners`);
      }
    });
  }
  
  /**
   * Apply a single delta to a snapshot (used for historical replay)
   * This is lighter-weight than the full applyDelta which updates listeners, etc.
   */
  private applyDeltaToSnapshot(
    operation: VEILOperation,
    facets: Map<string, Facet>,
    removals: Map<string, 'hide' | 'delete'>
  ): void {
    switch (operation.type) {
      case 'addFacet': {
        const cloned = this.cloneFacet(operation.facet);
        facets.set(cloned.id, cloned);
        break;
      }
      
      case 'rewriteFacet': {
        const existing = facets.get(operation.id);
        if (existing && operation.changes) {
          const updated = this.mergeFacetChanges(existing, operation.changes);
          facets.set(operation.id, updated);
        }
        break;
      }
      
      case 'removeFacet': {
        facets.delete(operation.id);
        removals.set(operation.id, 'delete');
        break;
      }
    }
  }
  
  /**
   * Merge changes into a facet (helper for both live and snapshot replay)
   */
  private mergeFacetChanges(existing: Facet, changes: Partial<Facet>): Facet {
    const updated = { ...existing };
    
    // Handle content
    if ('content' in changes && changes.content !== undefined) {
      (updated as any).content = changes.content;
    }
    
    // Handle state (deep merge)
    if ('state' in changes && changes.state) {
      const previousState = this.isPlainObject((updated as any).state)
        ? (updated as any).state
        : {};
      (updated as any).state = this.deepMergeObjects(
        previousState,
        changes.state as Record<string, any>
      );
    }
    
    // Handle other fields
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'state' || key === 'content' || value === undefined) {
        continue;
      }
      (updated as any)[key] = value;
    }
    
    return updated;
  }

  /**
   * Delete recent frames with selective component reinitialization
   * Fork-invariant components survive, others are recreated
   */
  async deleteRecentFramesWithReinit(
    count: number,
    space: Space
  ): Promise<FrameDeletionResult> {
    if (count <= 0) {
      throw new Error('Count must be positive');
    }
    
    if (count > this.state.frameHistory.length) {
      throw new Error(`Cannot delete ${count} frames, only ${this.state.frameHistory.length} exist`);
    }
    
    // Analyze and categorize components
    const { invariant, stateful } = this.categorizeComponents(space);

    // Prepare deletion - sort frames by sequence to ensure we delete the most recent ones
    const sortedFrames = [...this.state.frameHistory].sort((a, b) => b.sequence - a.sequence);
    const framesToDelete = sortedFrames.slice(0, count);
    const deletedRange = {
      from: Math.min(...framesToDelete.map(f => f.sequence)),
      to: Math.max(...framesToDelete.map(f => f.sequence))
    };
    const rollbackSequence = sortedFrames[count]?.sequence || 0;
    
    // Analyze what will be affected
    const analysis = this.analyzeAffectedState(framesToDelete);
    
    // Phase 3: Notify invariant components
    for (const { component } of invariant) {
      if ('onFrameFork' in component && typeof component.onFrameFork === 'function') {
        component.onFrameFork(deletedRange);
      }
    }
    
    // Phase 4: Capture component states at rollback point
    const componentSnapshots = await this.captureComponentStatesAtSequence(
      rollbackSequence,
      space,
      stateful
    );
    
    // Phase 5: Shutdown stateful components
    await this.shutdownComponents(stateful);
    
    // Phase 6: Execute frame deletion
    const deletionResult = this.executeFrameDeletion(count, rollbackSequence);
    deletionResult.affectedFacets = analysis.facets;
    deletionResult.warnings = analysis.warnings;
    
    // Phase 7: Skip component reinitialization - let frames rebuild naturally
    // Components will be rebuilt from remaining frame history when frames are replayed
    
    return deletionResult;
  }
  
  private categorizeComponents(space: Space): ComponentCategorization {
    const invariant: ComponentInfo[] = [];
    const stateful: ComponentInfo[] = [];
    
    space.components.forEach((component, index) => {
      const info: ComponentInfo = {
        component,
        index
      };
      
      if (isForkInvariant(component)) {
        invariant.push(info);
      } else {
        stateful.push(info);
      }
    });
    
    return { invariant, stateful };
  }
  
  private analyzeAffectedState(frames: Frame[]): {
    facets: Set<string>;
    warnings: string[];
  } {
    const affected = new Set<string>();
    const warnings: string[] = [];
    
    for (const frame of frames) {
      for (const op of frame.deltas) {
        switch (op.type) {
          case 'addFacet':
            affected.add(op.facet.id);
            if (op.facet.children?.length) {
              warnings.push(
                `Facet ${op.facet.id} has ${op.facet.children.length} children that will also be removed`
              );
            }
            break;
            
          case 'rewriteFacet':
            if (!this.state.facets.has(op.id)) {
              warnings.push(
                `Change operation on non-existent facet ${op.id} (might have been added in deleted frames)`
              );
            }
            break;
            
          case 'removeFacet':
            warnings.push(`Remove operation for ${op.id} will be undone`);
            break;
        }
      }
    }
    
    return { facets: affected, warnings };
  }
  
  private async captureComponentStatesAtSequence(
    targetSequence: number,
    space: Space,
    componentsToCapture: ComponentInfo[]
  ): Promise<ComponentStateSnapshot[]> {
    const snapshots: ComponentStateSnapshot[] = [];
    
    for (const info of componentsToCapture) {
      const component = info.component;
      const metadata = getPersistenceMetadata(component);
      
      const snapshot: ComponentStateSnapshot = {
        componentIndex: info.index,
        className: component.constructor.name,
        persistentProperties: {}
      };
      
      // Capture persistent properties
      if (metadata) {
        for (const [key, propMeta] of metadata.properties) {
          snapshot.persistentProperties[key] = (component as any)[key];
        }
      }
      
      snapshots.push(snapshot);
    }
    
    return snapshots;
  }
  
  private async shutdownComponents(components: ComponentInfo[]): Promise<void> {
    for (const { component } of components) {
      try {
        // Call shutdown lifecycle method if it exists
        if ('onShutdown' in component && typeof component.onShutdown === 'function') {
          await component.onShutdown();
        }
        
        // Force cleanup common resources
        this.cleanupComponentResources(component);
      } catch (error) {
        console.error(`Error shutting down ${component.constructor.name}:`, error);
      }
    }
  }
  
  private cleanupComponentResources(component: Component): void {
    const comp = component as any;
    
    // WebSocket connections
    if (comp.ws && typeof comp.ws.close === 'function') {
      comp.ws.close();
      comp.ws = null;
    }
    
    // Timers
    const timerProps = ['timeout', 'interval', 'reconnectTimeout', 'heartbeatInterval'];
    for (const prop of timerProps) {
      if (comp[prop]) {
        clearTimeout(comp[prop]);
        clearInterval(comp[prop]);
        comp[prop] = null;
      }
    }
    
    // Event listeners
    if (comp.listeners && typeof comp.listeners.clear === 'function') {
      comp.listeners.clear();
    }
    
    // Pending promises/callbacks
    if (comp.pendingPromises) {
      comp.pendingPromises = [];
    }
    if (comp.callbacks) {
      comp.callbacks = new Map();
    }
  }
  
  private executeFrameDeletion(count: number, rollbackSequence: number): FrameDeletionResult {
    // Sort frames by sequence to ensure we delete the most recent ones
    const sortedFrames = [...this.state.frameHistory].sort((a, b) => b.sequence - a.sequence);
    
    // Get the frames to delete (most recent N frames)
    const framesToDelete = sortedFrames.slice(0, count);
    const deletedSequences = new Set(framesToDelete.map(f => f.sequence));
    
    // Capture deleted frames info
    const deletedFrames = framesToDelete.map(f => ({
      sequence: f.sequence,
      type: 'deltas' in f ? 
        (f.deltas.some((op: any) => op.type === 'speak' || op.type === 'act') ? 'outgoing' : 'incoming') 
        : 'unknown',
      timestamp: f.timestamp,
      operationCount: f.deltas.length
    }));
    
    // Remove frames from history by filtering out deleted sequences
    this.state.frameHistory = this.state.frameHistory.filter(f => !deletedSequences.has(f.sequence));
    
    // Reset sequence number
    this.state.currentSequence = rollbackSequence;
    
    // Rebuild state by replaying remaining frames
    const oldFacets = this.state.facets;
    const oldRemovals = this.state.removals;
    const oldStreams = this.state.streams;
    
    // Clear current state
    this.state.facets = new Map();
    this.state.removals = new Map();
    this.state.streams = new Map();
    this.state.currentStream = undefined;
    
    // Replay all remaining frames
    const tempHistory = [...this.state.frameHistory];
    this.state.frameHistory = [];
    this.state.currentSequence = 0;
    
    try {
      for (const frame of tempHistory) {
        // No mutation needed - frames are immutable and already have correct sequences
        // Remaining frames are contiguous after deletion of most recent frames
        if ('deltas' in frame) {
          const isIncoming = !frame.deltas.some((op: any) => 
            op.type === 'speak' || op.type === 'act'
          );
          
          if (isIncoming) {
            this.applyFrame(frame);
          } else {
            this.applyFrame(frame);
          }
        }
      }
      
      this.notifyListeners();
    } catch (error: any) {
      // Rollback failed - restore original state
      this.state.facets = oldFacets;
      this.state.removals = oldRemovals;
      this.state.streams = oldStreams;
      throw new Error(`Frame deletion failed during replay: ${error.message}`);
    }
    
    return {
      deletedFrames,
      affectedFacets: new Set(),
      revertedSequence: this.state.currentSequence,
      warnings: []
    };
  }
  
  private async reinitializeComponents(
    space: Space,
    snapshots: ComponentStateSnapshot[]
  ): Promise<void> {
    for (const snapshot of snapshots) {
      // Component should already exist, just restore state
      const component = space.components[snapshot.componentIndex];
      if (!component) {
        console.warn(`Component at index ${snapshot.componentIndex} not found`);
        continue;
      }
      
      // Restore persistent properties
      Object.assign(component, snapshot.persistentProperties);
      
      // Call recovery lifecycle
      if ('onRecovery' in component && typeof component.onRecovery === 'function') {
        await component.onRecovery(
          this.state.currentSequence + snapshots.length,
          this.state.currentSequence
        );
      }
    }
  }
  
  private async triggerRecoveryFrame(space: Space, previousSequence: number): Promise<void> {
    // Emit recovery complete event
    space.emit({
      topic: 'system:recovery-complete',
      source: { componentId: 'system', componentPath: ['system'] },
      payload: {
        reason: 'frame-deletion',
        previousSequence,
        newSequence: this.state.currentSequence
      },
      timestamp: Date.now()
    });
    
    // Process a frame to let components react
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Type definitions for frame deletion
interface ComponentInfo {
  component: Component;
  index: number;
}

interface ComponentCategorization {
  invariant: ComponentInfo[];
  stateful: ComponentInfo[];
}

interface ComponentStateSnapshot {
  componentIndex: number;
  className: string;
  persistentProperties: Record<string, any>;
}

export interface FrameDeletionResult {
  deletedFrames: Array<{
    sequence: number;
    type: string;
    timestamp: string;
    operationCount: number;
  }>;
  affectedFacets: Set<string>;
  revertedSequence: number;
  warnings: string[];
}
