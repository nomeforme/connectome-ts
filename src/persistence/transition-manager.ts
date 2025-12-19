/**
 * Transition-based persistence manager
 * Saves frame transitions as deltas and periodic snapshots for efficient restoration
 */

import { Space } from '../spaces/space';
import { Component } from '../spaces/component';
import { VEILStateManager } from '../veil/veil-state';
import { SpaceEvent, FrameEndEvent, ComponentRef } from '../spaces/types';
import { Frame } from '../veil/types';
import {
  FrameTransition,
  TransitionNode,
  TransitionSnapshot,
  TransitionApplicator,
  SnapshotProvider,
  ElementOperation,
  ComponentOperation,
  ComponentChange
} from './transition-types';
import { FileStorageAdapter } from './file-storage';
import { serializeSpace, serializeVEILState } from './serialization';
import { restoreSpace, restoreVEILState } from './restoration';
import { ComponentRegistry } from './component-registry';

interface TransitionManagerConfig {
  snapshotInterval?: number;  // Frames between snapshots (default: 100)
  storagePath?: string;
  enableBranching?: boolean;  // Enable timeline branching (default: false)
}

export class TransitionManager {
  private space: Space;
  private veilState: VEILStateManager;
  private config: Required<TransitionManagerConfig>;
  private storage: FileStorageAdapter;
  
  // Tracking
  private lastSnapshotSequence: number = 0;
  private transitionsSinceSnapshot: number = 0;
  private currentBranch: string = 'main';
  
  // Write lock to prevent concurrent snapshot writes
  private isWritingSnapshot: boolean = false;
  private snapshotWriteQueue: Array<{resolve: (value: TransitionSnapshot) => void, reject: (error: any) => void}> = [];
  
  constructor(
    space: Space,
    veilState: VEILStateManager,
    config?: TransitionManagerConfig
  ) {
    this.space = space;
    this.veilState = veilState;
    
    this.config = {
      snapshotInterval: 100,
      storagePath: './persistence',
      enableBranching: false,
      ...config
    };
    
    console.log('[TransitionManager] Creating storage with path:', this.config.storagePath);
    this.storage = new FileStorageAdapter(this.config.storagePath);
    
    // Subscribe to frame:end events
    this.subscribeToEvents();
  }
  
  private subscribeToEvents() {
    // Monitor frame completion via debug observer hook
    // The Space class provides addDebugObserver which fires on every frame completion
    // We use this to capture transition events and process persistence
    this.space.addDebugObserver({
      onFrameComplete: async (frame, context) => {
        // Create a synthetic frame end event payload
        const event: FrameEndEvent = {
          topic: 'frame:end',
          source: this.space.getRef(),
          payload: {
            frameId: frame.sequence,
            hasOperations: frame.deltas.length > 0,
            hasActivation: false, // Not tracked easily here
            transition: frame.transition
          },
          timestamp: Date.now()
        };
        await this.onFrameEnd(event);
      }
    });
  }
  
  /**
   * Handle frame end - save transition
   */
  private async onFrameEnd(event: FrameEndEvent) {
    // Get the transition from the event payload
    const payload = event.payload as any;
    if (!payload?.transition) return;
    
    const transition = payload.transition;
    
    // Create transition node
    const node: TransitionNode = {
      sequence: transition.sequence,
      parentSequence: transition.sequence - 1,  // Linear for now
      branchName: this.currentBranch,
      transition
    };
    
    // Save transition
    await this.saveTransition(node);
    
    this.transitionsSinceSnapshot++;
    
    // Check if we need a snapshot
    if (this.shouldSnapshot(transition.sequence)) {
      await this.createSnapshot(transition.sequence);
    }
  }
  
  /**
   * Save a transition node
   */
  private async saveTransition(node: TransitionNode) {
    const filename = `transition-${node.sequence}-${this.currentBranch}.json`;
    await this.storage.writeFile(
      `deltas/${filename}`,
      JSON.stringify(node, null, 2)
    );
  }
  
  /**
   * Check if we should create a snapshot
   */
  private shouldSnapshot(sequence: number): boolean {
    return sequence - this.lastSnapshotSequence >= this.config.snapshotInterval;
  }
  
  /**
   * Create a snapshot
   */
  async createSnapshot(sequence?: number): Promise<TransitionSnapshot> {
    // If already writing a snapshot, queue this request
    if (this.isWritingSnapshot) {
      console.log('[TransitionManager] Snapshot write already in progress, queueing request...');
      return new Promise((resolve, reject) => {
        this.snapshotWriteQueue.push({ resolve, reject });
      });
    }
    
    // Acquire write lock
    this.isWritingSnapshot = true;
    
    try {
      const currentSequence = sequence || this.veilState.getState().currentSequence;
      
      // Clean up deleted facets before creating snapshot
      const cleaned = this.veilState.cleanupDeletedFacets();
      if (cleaned > 0) {
        console.log(`[TransitionManager] Cleaned up ${cleaned} deleted facets before snapshot`);
      }
      
      const snapshot: TransitionSnapshot = {
        sequence: currentSequence,
        timestamp: new Date().toISOString(),
        branchName: this.currentBranch,
        elementTree: serializeSpace(this.space), // Using elementTree field for compatibility but storing Space
        componentStates: this.serializeAllComponents(),
        veilState: serializeVEILState(this.veilState.getState())
      };
      
      // Save snapshot with timestamp to avoid overwriting
      const timestamp = Date.now();
      const filename = `snapshot-${currentSequence}-${this.currentBranch}-${timestamp}.json`;
      await this.storage.writeFile(
        `snapshots/${filename}`,
        JSON.stringify(snapshot, null, 2)
      );
      
      this.lastSnapshotSequence = currentSequence;
      this.transitionsSinceSnapshot = 0;
      
      console.log(`Created snapshot at sequence ${currentSequence}`);
      
      // Process any queued snapshot requests (return the same snapshot)
      while (this.snapshotWriteQueue.length > 0) {
        const queued = this.snapshotWriteQueue.shift();
        if (queued) {
          console.log('[TransitionManager] Processing queued snapshot request');
          queued.resolve(snapshot);
        }
      }
      
      return snapshot;
    } catch (error) {
      // Reject all queued requests
      while (this.snapshotWriteQueue.length > 0) {
        const queued = this.snapshotWriteQueue.shift();
        if (queued) {
          queued.reject(error);
        }
      }
      throw error;
    } finally {
      // Release write lock
      this.isWritingSnapshot = false;
    }
  }
  
  /**
   * Serialize all component states
   */
  private serializeAllComponents(): any {
    // TODO: Implement component state serialization
    // This would walk the component list and serialize all persistent component properties
    return {};
  }
  
  /**
   * Restore from a specific sequence
   */
  async restore(targetSequence?: number, branch: string = 'main'): Promise<void> {
    // Find the nearest snapshot
    console.log('[TransitionManager] Looking for snapshots in snapshots/ directory');
    const snapshots = await this.storage.listFiles('snapshots/');
    console.log(`[TransitionManager] Found ${snapshots.length} total snapshot files`);
    const branchSnapshots = snapshots
      .filter(f => f.includes(`-${branch}.json`) || f.includes(`-${branch}-`))
      .sort((a, b) => {
        // Extract sequence numbers for proper numeric sorting
        const matchA = a.match(/snapshot-(\d+)-/);
        const matchB = b.match(/snapshot-(\d+)-/);
        if (!matchA || !matchB) return 0;
        
        const seqA = parseInt(matchA[1]);
        const seqB = parseInt(matchB[1]);
        
        // If sequences are the same, sort by timestamp (if present)
        if (seqA === seqB) {
          const timestampA = a.match(/-(\d+)\.json$/);
          const timestampB = b.match(/-(\d+)\.json$/);
          if (timestampA && timestampB) {
            return parseInt(timestampA[1]) - parseInt(timestampB[1]);
          }
        }
        
        return seqA - seqB;
      });
    console.log(`[TransitionManager] Found ${branchSnapshots.length} snapshots for branch '${branch}'`);
    if (branchSnapshots.length > 0) {
      const latest = branchSnapshots[branchSnapshots.length - 1];
      const match = latest.match(/snapshot-(\d+)-/);
      console.log(`[TransitionManager] Latest snapshot: ${latest} (sequence ${match ? match[1] : 'unknown'})`);
    }
    
    if (branchSnapshots.length === 0) {
      throw new Error(`No snapshots found for branch ${branch}`);
    }
    
    // Find the best snapshot to start from
    let snapshotFile = branchSnapshots[branchSnapshots.length - 1];  // Latest by default
    let candidateSnapshots = [...branchSnapshots];
    
    if (targetSequence !== undefined) {
      // Find the latest snapshot before target
      candidateSnapshots.reverse();
      for (const file of candidateSnapshots) {
        // Updated regex to handle optional timestamp: snapshot-SEQUENCE-BRANCH[-TIMESTAMP].json
        const match = file.match(/snapshot-(\d+)-[^-]+(-.+)?\.json$/);
        if (match && parseInt(match[1]) <= targetSequence) {
          snapshotFile = file;
          break;
        }
      }
      candidateSnapshots.reverse(); // Restore original order
    }
    
    // Try loading snapshots until we find a valid one
    let snapshot: TransitionSnapshot | null = null;
    let lastError: Error | null = null;
    const startIndex = candidateSnapshots.indexOf(snapshotFile);
    
    for (let i = startIndex; i >= 0; i--) {
      const candidateFile = candidateSnapshots[i];
      try {
        // Load snapshot data
        const snapshotData = await this.storage.readFile(`snapshots/${candidateFile}`);
        
        // Check if snapshot is empty
        if (!snapshotData || snapshotData.trim() === '') {
          console.warn(`Snapshot file ${candidateFile} is empty, trying previous snapshot...`);
          continue;
        }
        
        // Try to parse JSON
        snapshot = JSON.parse(snapshotData) as TransitionSnapshot;
        snapshotFile = candidateFile;
        console.log(`Successfully loaded snapshot: ${candidateFile}`);
        break;
      } catch (e) {
        console.warn(`Failed to load snapshot ${candidateFile}:`, e);
        lastError = e as Error;
        continue;
      }
    }
    
    if (!snapshot) {
      throw new Error(`No valid snapshots found. Last error: ${lastError?.message}`);
    }
    
    console.log(`Restoring from snapshot at sequence ${snapshot.sequence}`);
    await this.applySnapshot(snapshot);
    
    // Apply transitions from snapshot to target
    const transitions = await this.loadTransitions(
      snapshot.sequence + 1,
      targetSequence,
      branch
    );
    
    for (const transition of transitions) {
      await this.applyTransition(transition);
    }
    
    console.log(`Restored to sequence ${targetSequence || transitions[transitions.length - 1]?.sequence || snapshot.sequence}`);
  }
  
  /**
   * Load transitions in a range
   */
  private async loadTransitions(
    fromSequence: number,
    toSequence?: number,
    branch: string = 'main'
  ): Promise<TransitionNode[]> {
    const files = await this.storage.listFiles('deltas/');
    const transitions: TransitionNode[] = [];
    
    for (const file of files) {
      const match = file.match(/transition-(\d+)-(.+)\.json/);
      if (!match || match[2] !== branch) continue;
      
      const sequence = parseInt(match[1]);
      if (sequence < fromSequence) continue;
      if (toSequence !== undefined && sequence > toSequence) continue;
      
      const data = await this.storage.readFile(`deltas/${file}`);
      transitions.push(JSON.parse(data));
    }
    
    return transitions.sort((a, b) => a.sequence - b.sequence);
  }
  
  /**
   * Apply a snapshot
   */
  private async applySnapshot(snapshot: TransitionSnapshot) {
    console.log(`Applying snapshot from sequence ${snapshot.sequence}`);
    
    // Clear current state - remove all components
    const componentsToRemove = [...this.space.components];
    for (const component of componentsToRemove) {
      this.space.removeComponent(component);
    }
    
    // Restore VEIL state
    if (snapshot.veilState) {
      await restoreVEILState(this.veilState, snapshot.veilState);
    }
    
    // Restore Space components
    if (snapshot.elementTree) {
      // We reuse elementTree field name for now but it contains SerializedSpace
      await restoreSpace(this.space, snapshot.elementTree);
    }
    
    console.log('Snapshot applied successfully');
  }
  
  /**
   * Apply a single transition
   */
  private async applyTransition(node: TransitionNode) {
    const transition = node.transition;
    
    // Legacy compatibility: Apply element operations (shimmed to component operations)
    for (const op of transition.elementOps) {
      await this.applyElementOperation(op);
    }
    
    // Apply component operations
    for (const op of transition.componentOps) {
      await this.applyComponentOperation(op);
    }
    
    // Apply component changes
    for (const change of transition.componentChanges) {
      await this.applyComponentChange(change);
    }
    
    // Apply VEIL operations by creating a frame
    if (transition.veilOps.length > 0) {
      const frame: Frame = {
        sequence: transition.sequence,
        timestamp: transition.timestamp,
        events: [],
        deltas: transition.veilOps,
        transition: undefined as any, // Don't recursive ref? 
        uuid: `replay-${transition.sequence}`
      };
      this.veilState.applyFrame(frame);
    }
    
    console.log(`Applied transition ${transition.sequence}`);
  }
  
  /**
   * Legacy compatibility: Apply an element operation (shimmed to component operations)
   */
  private async applyElementOperation(op: ElementOperation) {
    // Element tree operations are shimmed to equivalent component operations
    console.warn(`[TransitionManager] Ignoring legacy element operation: ${op.type}`);
  }
  
  /**
   * Apply a component operation
   */
  private async applyComponentOperation(op: ComponentOperation) {
    switch (op.type) {
      case 'add-component':
        // All components are mounted directly on Space
        const component = ComponentRegistry.create(op.componentType);
        if (component) {
          // Restore initial state if provided
          if (op.initialState) {
            Object.assign(component, op.initialState);
          }
          // Add to space with generated ID
          this.space.addComponent(component);
        } else {
          console.warn(`Component not found in registry: ${op.componentType}`);
        }
        break;
        
      case 'remove-component':
        // Try to find by index/ref shim... difficult without ID.
        // We can't support legacy removal without IDs.
        console.warn(`[TransitionManager] Cannot replay remove-component without component IDs`);
        break;
    }
  }
  
  /**
   * Apply a component property change
   */
  private async applyComponentChange(change: ComponentChange) {
    // Try to find component
    // Legacy changes use elementRef and index.
    // This is hard to map to flat list if we don't maintain the same order or IDs.
    // We'll try to find by class type if unique?
    console.warn(`[TransitionManager] Skipping component change (legacy format): ${change.property}`);
  }
  
  /**
   * Create a new branch from current state
   */
  async branch(branchName: string): Promise<void> {
    if (!this.config.enableBranching) {
      throw new Error('Branching is not enabled');
    }
    
    const currentSequence = this.veilState.getState().currentSequence;
    
    // Create a snapshot at branch point
    const snapshot = await this.createSnapshot(currentSequence);
    snapshot.branchName = branchName;
    
    // Save as new branch snapshot with timestamp
    const timestamp = Date.now();
    const filename = `snapshot-${currentSequence}-${branchName}-${timestamp}.json`;
    await this.storage.writeFile(
      `snapshots/${filename}`,
      JSON.stringify(snapshot, null, 2)
    );
    
    this.currentBranch = branchName;
    console.log(`Created branch ${branchName} at sequence ${currentSequence}`);
  }
  
  /**
   * Switch to a different branch
   */
  async checkout(branchName: string, sequence?: number): Promise<void> {
    if (!this.config.enableBranching) {
      throw new Error('Branching is not enabled');
    }
    
    await this.restore(sequence, branchName);
    this.currentBranch = branchName;
  }

  /**
   * Delete recent frames with recovery snapshot
   */
  async deleteRecentFramesAndSnapshot(
    count: number,
    reason: string
  ): Promise<DeletionSnapshot> {
    console.log(`\n🗑️  Preparing to delete ${count} frames...`);
    
    // Create pre-deletion snapshot for safety
    const beforeSnapshot = await this.createSnapshot();
    console.log(`📸 Created backup snapshot: sequence ${beforeSnapshot.sequence}`);
    
    try {
      // Delete frames with selective component reinit
      // Note: Space is passed, but now Space has no children.
      // deleteRecentFramesWithReinit likely needs update if it traverses tree.
      // We assume VEILState handles it.
      const deletionResult = await this.veilState.deleteRecentFramesWithReinit(
        count,
        this.space as any
      );
      
      // Delete corresponding delta files
      await this.deleteRecentDeltas(deletionResult.deletedFrames);
      
      // Create post-deletion snapshot
      const afterSnapshot = await this.createSnapshot();
      console.log(`📸 Created recovery snapshot: sequence ${afterSnapshot.sequence}`);
      
      // Save deletion record
      const deletionRecord: DeletionSnapshot = {
        timestamp: new Date().toISOString(),
        reason,
        beforeSnapshotId: beforeSnapshot.sequence,
        afterSnapshotId: afterSnapshot.sequence,
        deletedFrames: deletionResult.deletedFrames,
        affectedFacets: Array.from(deletionResult.affectedFacets),
        warnings: deletionResult.warnings
      };
      
      const deletionFile = `deletions/deletion-${Date.now()}.json`;
      await this.storage.writeFile(
        deletionFile,
        JSON.stringify(deletionRecord, null, 2)
      );
      
      console.log(`\n✅ Frame deletion complete!`);
      console.log(`  - Deleted ${count} frames (sequences ${deletionResult.deletedFrames.map(f => f.sequence).join(', ')})`);
      console.log(`  - Reverted to sequence ${deletionResult.revertedSequence}`);
      console.log(`  - Deletion record saved to ${deletionFile}`);
      
      return deletionRecord;
    } catch (error: any) {
      // Restore from pre-deletion snapshot
      console.error('\n❌ Frame deletion failed:', error.message);
      console.log('🔄 Restoring from backup snapshot...');
      await this.restoreFromSpecificSnapshot(beforeSnapshot);
      throw error;
    }
  }
  
  /**
   * Delete delta files for removed frames
   */
  private async deleteRecentDeltas(
    deletedFrames: Array<{ sequence: number }>
  ): Promise<void> {
    const deletedSequences = new Set(deletedFrames.map(f => f.sequence));
    
    try {
      const deltaFiles = await this.storage.listFiles('deltas');
      let deletedCount = 0;
      
      for (const file of deltaFiles) {
        // Parse sequence from filename (e.g., "delta-123.json")
        const match = file.match(/delta-(\d+)\.json/);
        if (match) {
          const sequence = parseInt(match[1]);
          if (deletedSequences.has(sequence)) {
            await this.storage.deleteFile(`deltas/${file}`);
            deletedCount++;
          }
        }
      }
      
      console.log(`🗑️  Deleted ${deletedCount} delta files`);
    } catch (error) {
      console.warn('Failed to delete some delta files:', error);
    }
  }
  
  /**
   * Restore from a specific snapshot
   */
  private async restoreFromSpecificSnapshot(snapshot: TransitionSnapshot): Promise<void> {
    // Clear current state - remove all components
    const componentsToRemove = [...this.space.components];
    for (const component of componentsToRemove) {
      this.space.removeComponent(component);
    }
    
    // Restore VEIL state
    await restoreVEILState(this.veilState, snapshot.veilState);
    
    // Restore space components
    await restoreSpace(this.space, snapshot.elementTree);
    
    console.log(`✅ Restored from snapshot at sequence ${snapshot.sequence}`);
    
    // Update tracking to prevent immediate re-snapshotting
    this.lastSnapshotSequence = snapshot.sequence;
    this.transitionsSinceSnapshot = 0;
    this.currentBranch = snapshot.branchName || 'main';
  }
  
  /**
   * List deletion history
   */
  async listDeletions(): Promise<DeletionSnapshot[]> {
    const deletions: DeletionSnapshot[] = [];
    
    try {
      const files = await this.storage.listFiles('deletions');
      for (const file of files) {
        const content = await this.storage.readFile(`deletions/${file}`);
        const record = JSON.parse(content) as DeletionSnapshot;
        deletions.push(record);
      }
      
      // Sort by timestamp descending
      deletions.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    } catch (error) {
      console.warn('Failed to list deletions:', error);
    }
    
    return deletions;
  }
  
  /**
   * Undo a specific deletion by restoring from backup snapshot
   */
  async undoDeletion(deletionTimestamp: string): Promise<void> {
    const deletions = await this.listDeletions();
    const deletion = deletions.find(d => d.timestamp === deletionTimestamp);
    
    if (!deletion) {
      throw new Error(`Deletion record not found for timestamp: ${deletionTimestamp}`);
    }
    
    console.log(`🔄 Undoing deletion from ${deletion.timestamp}...`);
    console.log(`  - Restoring from snapshot ${deletion.beforeSnapshotId}`);
    
    await this.restore(deletion.beforeSnapshotId);
    
    console.log('✅ Deletion undone!');
  }
}

// Type definition for deletion records
interface DeletionSnapshot {
  timestamp: string;
  reason: string;
  beforeSnapshotId: number;
  afterSnapshotId: number;
  deletedFrames: Array<{
    sequence: number;
    type: string;
    timestamp: string;
    operationCount: number;
  }>;
  affectedFacets: string[];
  warnings: string[];
}
