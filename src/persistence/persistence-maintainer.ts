/**
 * PersistenceMaintainer - Handles persistence of VEIL state
 *
 * FLEX Component (constraint: priority 400) that runs after all other processing is complete.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { VEILStateManager } from '../veil/veil-state';
import { FileStorageAdapter } from './file-storage';
import { FrameDelta, PersistenceSnapshot } from './types';
import { serializeVEILState, serializeSpace } from './serialization';
import { Frame } from '../veil/types';
import { Space } from '../spaces/space';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';

export interface PersistenceMaintainerConfig {
  storagePath: string;
  snapshotInterval?: number; // Default: every 100 frames
  maxDeltasPerFile?: number; // Default: 1000
  maxFrameHistory?: number;  // Max frames kept in memory (default: 2000)
}

export class PersistenceMaintainer extends Component {
  constraints = [priorityConstraint(ComponentPriority.MAINTAINER)];

  private storage: FileStorageAdapter;
  private lastSnapshotSequence: number = 0;

  // Named 'rootSpace' to avoid conflict with Component.space getter
  private rootSpace: Space;
  private veilState: VEILStateManager;
  private config: PersistenceMaintainerConfig;

  constructor(
    veilState: VEILStateManager,
    space: Space,
    config: PersistenceMaintainerConfig
  ) {
    super();
    this.veilState = veilState;
    this.rootSpace = space;
    this.config = config;
    this.storage = new FileStorageAdapter(config.storagePath);
  }

  execute(context: ExecutionContext): void {
    const { frame, state } = context;

    if (!frame) return;

    // Skip streaming frames - they're lightweight incremental chunks that would
    // flood persistence. The final content is captured in 'activation:completed'.
    const isStreamingFrame = frame.events?.some(e => e.topic === 'activation:stream');
    if (isStreamingFrame) {
      return;
    }

    // Save the frame delta (fire and forget)
    this.saveDelta(frame as Frame, frame.sequence).catch(err => {
      console.error('[PersistenceMaintainer] Failed to save delta:', err);
    });

    // Check if we need a snapshot
    const snapshotInterval = this.config.snapshotInterval || 100;
    const currentSequence = this.veilState.getState().currentSequence;
    if (currentSequence - this.lastSnapshotSequence >= snapshotInterval) {
      this.createSnapshot(currentSequence).catch(err => {
        console.error('[PersistenceMaintainer] Failed to create snapshot:', err);
      });
      this.lastSnapshotSequence = currentSequence;
    }
  }

  private async saveDelta(frame: Frame, sequence: number): Promise<void> {
    const minimalFrame: Frame = {
      sequence: frame.sequence,
      timestamp: frame.timestamp,
      uuid: frame.uuid,
      events: [],
      deltas: frame.deltas,
      activeStream: frame.activeStream,
      renderedSnapshot: frame.renderedSnapshot,
      transition: {
        sequence: frame.transition.sequence,
        timestamp: frame.transition.timestamp,
        elementOps: [],
        componentOps: [],
        componentChanges: [],
        veilOps: []
      }
    };

    const delta: FrameDelta = {
      sequence,
      timestamp: frame.timestamp,
      lifecycleId: this.rootSpace.lifecycleId,
      frame: minimalFrame
    };

    await this.storage.saveDelta(delta);
  }

  async createSnapshot(sequence?: number): Promise<void> {
    const state = this.veilState.getState();
    const snapshotSequence = sequence !== undefined ? sequence : state.currentSequence;
    const serializedSpace = serializeSpace(this.rootSpace);

    // Determine fragment boundaries:
    // Only include frames since lastSnapshotSequence (fragment snapshot).
    // First snapshot after startup (lastSnapshotSequence === 0) includes all in-memory frames.
    const fromSequence = this.lastSnapshotSequence > 0 ? this.lastSnapshotSequence : undefined;

    const serializedVEILState = serializeVEILState(state, fromSequence);

    // Determine fragment range from the serialized frames
    const frameCount = serializedVEILState.frameHistory?.length || 0;
    let fragmentStartSequence: number | undefined;
    let fragmentEndSequence: number | undefined;
    if (fromSequence !== undefined && frameCount > 0) {
      fragmentStartSequence = fromSequence + 1;
      fragmentEndSequence = snapshotSequence;
    }

    const snapshot: PersistenceSnapshot = {
      version: 1,
      timestamp: new Date().toISOString(),
      sequence: snapshotSequence,
      lifecycleId: this.rootSpace.lifecycleId,
      spaceId: this.rootSpace.id,
      veilState: serializedVEILState,
      space: serializedSpace,
      ...(fragmentStartSequence !== undefined && { fragmentStartSequence }),
      ...(fragmentEndSequence !== undefined && { fragmentEndSequence }),
      metadata: {
        facetCount: state.facets.size,
        streamCount: state.streams.size,
        agentCount: state.agents.size,
        frameCount,
        isFragment: fromSequence !== undefined
      }
    };

    await this.storage.saveSnapshot(snapshot);
    this.lastSnapshotSequence = snapshotSequence;
    console.log(`[PersistenceMaintainer] Created ${fromSequence !== undefined ? 'fragment' : 'full'} snapshot at sequence ${snapshotSequence} (${frameCount} frames)`);
  }
}
