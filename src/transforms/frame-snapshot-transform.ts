/**
 * FrameSnapshotTransform
 *
 * FLEX Component (constraint: priority 200 - Transform level) that captures rendered
 * snapshots of frames at creation time. Runs late in execution (after state
 * stabilizes) to capture the frame's final rendered appearance with facet attribution.
 *
 * This preserves the original subjective experience for compression,
 * even if later transforms modify earlier frames.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { ReadonlyVEILState } from '../spaces/receptor-effector-types';
import { VEILDelta } from '../veil/types';
import { FrameTrackingHUD } from '../hud/frame-tracking-hud';
import { VEILStateManager } from '../veil/veil-state';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';

export interface FrameSnapshotTransformOptions {
  /**
   * The HUD to use for rendering frames
   */
  hud?: FrameTrackingHUD;

  /**
   * Whether to capture snapshots (can be disabled for testing/debugging)
   */
  enabled?: boolean;

  /**
   * Whether to log snapshot captures
   */
  verbose?: boolean;
}

export class FrameSnapshotTransform extends Component {
  // Run late in execution, after other transforms have stabilized state
  // TODO [constraint-solver]: Replace with provides = ['frame-snapshots']
  constraints = [priorityConstraint(ComponentPriority.TRANSFORM)];

  private hud: FrameTrackingHUD;
  private captureEnabled: boolean;
  private verbose: boolean;

  constructor(options: FrameSnapshotTransformOptions = {}) {
    super();

    this.hud = options.hud || new FrameTrackingHUD();
    this.captureEnabled = options.enabled !== false;  // Default: true
    this.verbose = options.verbose || false;
  }

  execute(context: ExecutionContext): void {
    if (!this.captureEnabled) {
      return;
    }

    const { state } = context;

    // Get the most recent frame
    const frameHistory = state.frameHistory;
    if (frameHistory.length === 0) {
      return;
    }

    const latestFrame = frameHistory[frameHistory.length - 1];

    // Skip if already has a snapshot
    if (latestFrame.renderedSnapshot) {
      return;
    }

    // Capture snapshot
    try {
      const snapshot = this.hud.captureFrameSnapshot(
        latestFrame,
        new Map(state.facets)
      );

      // Store snapshot directly on the frame object
      latestFrame.renderedSnapshot = snapshot;

      if (this.verbose) {
        console.log(
          `[FrameSnapshotTransform] Captured snapshot for frame ${latestFrame.sequence}: ` +
          `${snapshot.chunks.length} chunks, ${snapshot.totalTokens} tokens`
        );
      }
    } catch (error) {
      console.error(
        `[FrameSnapshotTransform] Failed to capture snapshot for frame ${latestFrame.sequence}:`,
        error
      );
    }

    // No operations - this is a side effect on the frame object
  }
  
  /**
   * Enable or disable snapshot capture
   */
  setEnabled(enabled: boolean): void {
    this.captureEnabled = enabled;
  }
  
  /**
   * Check if snapshot capture is enabled
   */
  isEnabled(): boolean {
    return this.captureEnabled;
  }
}
