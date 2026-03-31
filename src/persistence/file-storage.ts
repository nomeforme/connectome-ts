/**
 * File-based storage adapter for persistence
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  StorageAdapter,
  PersistenceSnapshot,
  FrameDelta,
  FrameBucketRef
} from './types';
import type { Frame } from '../veil/types';
import { FrameBucketStore } from './frame-bucket-store';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const readdir = promisify(fs.readdir);
const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);

export class FileStorageAdapter implements StorageAdapter {
  private basePath: string;
  private snapshotDir: string;
  private deltaDir: string;
  private bucketStore: FrameBucketStore;
  private maxSnapshots: number;

  // Write locks to prevent concurrent writes to the same file
  private writeLocks: Map<string, Promise<void>> = new Map();

  constructor(basePath: string, maxSnapshots: number = 5) {
    this.basePath = basePath;
    this.maxSnapshots = maxSnapshots;
    this.snapshotDir = path.join(basePath, 'snapshots');
    this.deltaDir = path.join(basePath, 'deltas');
    this.bucketStore = new FrameBucketStore({
      storageDir: basePath,
      bucketSize: 100  // 100 frames per bucket
    });

    console.log('[FileStorageAdapter] Created with basePath:', this.basePath);
    console.log('[FileStorageAdapter] snapshotDir:', this.snapshotDir);
    console.log('[FileStorageAdapter] deltaDir:', this.deltaDir);
    console.log('[FileStorageAdapter] maxSnapshots:', this.maxSnapshots);

    // Ensure directories exist
    this.ensureDirectories();
  }
  
  private async ensureDirectories() {
    try {
      await mkdir(this.basePath, { recursive: true });
      await mkdir(this.snapshotDir, { recursive: true });
      await mkdir(this.deltaDir, { recursive: true });
      await this.bucketStore.initialize();
    } catch (error) {
      // Directories might already exist
    }
  }
  
  /**
   * Save a snapshot (with bucketed frame storage)
   */
  async saveSnapshot(snapshot: PersistenceSnapshot): Promise<void> {
    await this.ensureDirectories();
    
    const filename = `snapshot-${snapshot.sequence}-${Date.now()}.json`;
    const filepath = path.join(this.snapshotDir, filename);
    const tempPath = filepath + '.tmp';
    
    try {
      // Debug: Check what we're trying to save
      console.log(`[FileStorageAdapter] saveSnapshot - veilState keys:`, Object.keys(snapshot.veilState || {}));
      console.log(`[FileStorageAdapter] saveSnapshot - frameHistory length:`, snapshot.veilState?.frameHistory?.length || 0);
      
      // Extract frame history and create buckets
      const frameHistory = snapshot.veilState?.frameHistory || [];
      if (frameHistory.length > 0) {
        console.log(`[FileStorageAdapter] Creating buckets for ${frameHistory.length} frames...`);
        const bucketRefs = await this.bucketStore.createBuckets(frameHistory);
        console.log(`[FileStorageAdapter] Created ${bucketRefs.length} frame buckets`);
        
        // Replace frameHistory with bucket references in snapshot
        snapshot.veilState.frameBucketRefs = bucketRefs;
        delete snapshot.veilState.frameHistory;  // Don't save full history!
      } else {
        console.log(`[FileStorageAdapter] No frames to bucket (frameHistory empty)`);
      }
      
      // Write snapshot to temporary file first
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2));
      
      // Atomically rename temp file to final destination
      await promisify(fs.rename)(tempPath, filepath);
      
      console.log(`[FileStorageAdapter] Saved snapshot ${filename} (${frameHistory.length} frames in ${snapshot.veilState.frameBucketRefs?.length || 0} buckets)`);
      
      // NOTE: Snapshot/delta/bucket cleanup is implemented but disabled.
      // Snapshots are now bounded (~9MB vs 144MB) so disk growth is manageable.
      // Old snapshots + deltas + buckets form a perfect archival chain —
      // enable cleanup only when archival reconstruction is not needed.
      // await this.cleanupOldSnapshots();
    } catch (error) {
      // Clean up temp file if something went wrong
      try {
        await unlink(tempPath);
      } catch {}
      throw error;
    }
  }
  
  /**
   * Load a snapshot
   */
  async loadSnapshot(id: string): Promise<PersistenceSnapshot | null> {
    const filepath = path.join(this.snapshotDir, id);
    console.log(`[FileStorageAdapter] Attempting to load snapshot: ${id} from ${filepath}`);
    
    try {
      const data = await readFile(filepath, 'utf-8');
      console.log(`[FileStorageAdapter] Read ${data.length} bytes from snapshot file`);
      
      const snapshot = JSON.parse(data);
      
      // Validate snapshot structure
      if (!snapshot || typeof snapshot !== 'object') {
        console.error(`[FileStorageAdapter] Invalid snapshot ${id}: not an object`);
        return null;
      }
      
      console.log(`[FileStorageAdapter] Snapshot ${id} basic structure:`, {
        hasElementTree: !!snapshot.elementTree,
        hasSpace: !!snapshot.space,
        hasVeilState: !!snapshot.veilState,
        sequence: snapshot.sequence,
        frameCount: snapshot.veilState?.frames?.length || 0
      });

      // Support both legacy (elementTree) and new (space) formats
      const spaceData = snapshot.space || snapshot.elementTree;

      if (!spaceData || typeof spaceData !== 'object') {
        console.error(`[FileStorageAdapter] Invalid snapshot ${id}: missing or invalid space/elementTree`);
        return null;
      }

      // Validate structure (both formats should have components array)
      const componentsField = spaceData.components || spaceData.children;
      if (!Array.isArray(componentsField)) {
        console.error(`[FileStorageAdapter] Invalid snapshot ${id}: space/elementTree missing components/children array`);
        return null;
      }

      // Normalize to new format if loading legacy snapshot
      if (snapshot.elementTree && !snapshot.space) {
        console.warn(`⚠️  [FileStorageAdapter] DEPRECATED: Snapshot ${id} uses legacy 'elementTree' format`);
        console.warn(`    The 'elementTree' field is deprecated in favor of 'space'.`);
        console.warn(`    This snapshot will be automatically migrated on next save.`);
        snapshot.space = snapshot.elementTree;
        // Keep elementTree for backward compatibility during transition
      }
      
      // Load frames from buckets if using new format
      if (snapshot.veilState?.frameBucketRefs && snapshot.veilState.frameBucketRefs.length > 0) {
        console.log(`[FileStorageAdapter] Loading ${snapshot.veilState.frameBucketRefs.length} frame buckets...`);
        const frames = await this.bucketStore.loadFrames(snapshot.veilState.frameBucketRefs);
        snapshot.veilState.frameHistory = frames;
        console.log(`[FileStorageAdapter] Restored ${frames.length} frames from buckets`);
      }
      
      console.log(`[FileStorageAdapter] Successfully loaded snapshot ${id} with sequence ${snapshot.sequence}`);
      return snapshot;
    } catch (error) {
      console.error(`[FileStorageAdapter] Failed to load snapshot ${id}:`, error);
      return null;
    }
  }
  
  /**
   * List available snapshots
   */
  async listSnapshots(): Promise<string[]> {
    try {
      const files = await readdir(this.snapshotDir);
      const snapshotFiles = files.filter(f => f.startsWith('snapshot-') && f.endsWith('.json'));
      
      console.log(`[FileStorageAdapter] Found ${snapshotFiles.length} snapshot files in ${this.snapshotDir}:`);
      snapshotFiles.forEach(f => console.log(`  - ${f}`));
      
      const sorted = snapshotFiles.sort((a, b) => {
        // Extract sequence numbers and timestamps for proper numeric sorting
        // Handle both formats:
        // - snapshot-{sequence}-{timestamp}.json (from FileStorageAdapter)
        // - snapshot-{sequence}-{branch}-{timestamp}.json (from TransitionManager)
        
        // Try format with branch first
        let aMatch = a.match(/snapshot-(\d+)-(\w+)-(\d+)\.json/);
        let bMatch = b.match(/snapshot-(\d+)-(\w+)-(\d+)\.json/);
        
        let aSeq, aTime, bSeq, bTime;
        
        if (aMatch) {
          aSeq = parseInt(aMatch[1]);
          aTime = parseInt(aMatch[3]); // Note: timestamp is at index 3 when branch is present
        } else {
          // Try format without branch
          aMatch = a.match(/snapshot-(\d+)-(\d+)\.json/);
          if (aMatch) {
            aSeq = parseInt(aMatch[1]);
            aTime = parseInt(aMatch[2]);
          }
        }
        
        if (bMatch) {
          bSeq = parseInt(bMatch[1]);
          bTime = parseInt(bMatch[3]); // Note: timestamp is at index 3 when branch is present
        } else {
          // Try format without branch
          bMatch = b.match(/snapshot-(\d+)-(\d+)\.json/);
          if (bMatch) {
            bSeq = parseInt(bMatch[1]);
            bTime = parseInt(bMatch[2]);
          }
        }
        
        if (!aMatch || aTime === undefined) {
          console.warn(`[FileStorageAdapter] Snapshot filename doesn't match expected pattern: ${a}`);
          if (!bMatch || bTime === undefined) return a.localeCompare(b);
          return 1; // Put non-matching files at the end
        }
        if (!bMatch || bTime === undefined) {
          console.warn(`[FileStorageAdapter] Snapshot filename doesn't match expected pattern: ${b}`);
          return -1; // Put non-matching files at the end
        }
        
        // Sort by timestamp in ascending order (oldest to newest)
        // The host takes the last element, so the newest will be at the end
        // This allows for deletion of garbage frames, updates, etc.
        const result = aTime - bTime;
        console.log(`[FileStorageAdapter] Compare: ${a} (seq=${aSeq}, time=${aTime}) vs ${b} (seq=${bSeq}, time=${bTime}) => ${result}`);
        return result;
      });
      
      console.log(`[FileStorageAdapter] Sorted snapshots (oldest to newest):`);
      sorted.forEach((f, i) => {
        const match = f.match(/snapshot-(\d+)-(?:(\w+)-)?(\d+)\.json/);
        if (match) {
          const seq = match[1];
          const branch = match[2] || 'none';
          const timestamp = match[3];
          console.log(`  ${i}: ${f} (seq=${seq}, branch=${branch}, time=${timestamp})`);
        }
      });
      
      if (sorted.length > 0) {
        console.log(`[FileStorageAdapter] Latest snapshot will be: ${sorted[sorted.length - 1]}`);
      }
      
      return sorted;
    } catch (error) {
      console.error('[FileStorageAdapter] Error listing snapshots:', error);
      return [];
    }
  }
  
  /**
   * Save a delta
   */
  async saveDelta(delta: FrameDelta): Promise<void> {
    await this.ensureDirectories();
    
    const filename = `delta-${delta.sequence}.json`;
    const filepath = path.join(this.deltaDir, filename);
    
    // Compress if configured
    const data = this.config?.compressDeltas 
      ? await this.compressDelta(delta)
      : JSON.stringify(delta);
    
    await writeFile(filepath, data);
  }
  
  /**
   * Load deltas
   */
  async loadDeltas(fromSequence: number, toSequence?: number, lifecycleId?: string): Promise<FrameDelta[]> {
    try {
      const files = await readdir(this.deltaDir);
      const deltaFiles = files
        .filter(f => f.startsWith('delta-') && f.endsWith('.json'))
        .sort((a, b) => {
          // Sort by numeric sequence, not alphabetically
          const seqA = parseInt(a.match(/delta-(\d+)\.json/)?.[1] || '0');
          const seqB = parseInt(b.match(/delta-(\d+)\.json/)?.[1] || '0');
          return seqA - seqB;
        });
      
      const deltas: FrameDelta[] = [];
      
      for (const file of deltaFiles) {
        const match = file.match(/delta-(\d+)\.json/);
        if (!match) continue;
        
        const sequence = parseInt(match[1]);
        if (sequence < fromSequence) continue;
        if (toSequence && sequence > toSequence) break;
        
        const filepath = path.join(this.deltaDir, file);
        const data = await readFile(filepath, 'utf-8');
        
        const delta = this.config?.compressDeltas
          ? await this.decompressDelta(data)
          : JSON.parse(data);
        
        // Filter by lifecycleId if provided
        if (lifecycleId && delta.lifecycleId && delta.lifecycleId !== lifecycleId) {
          console.log(`[FileStorageAdapter] Skipping delta ${sequence} from different lifecycle (${delta.lifecycleId})`);
          continue;
        }
          
        deltas.push(delta);
      }
      
      console.log(`[FileStorageAdapter] Loaded ${deltas.length} deltas for lifecycle ${lifecycleId || 'any'}`);
      return deltas;
    } catch (error) {
      return [];
    }
  }
  
  /**
   * Clear all stored data
   */
  async clear(): Promise<void> {
    // Clear snapshots
    try {
      const snapshots = await readdir(this.snapshotDir);
      for (const file of snapshots) {
        await unlink(path.join(this.snapshotDir, file));
      }
    } catch (error) {
      // Ignore errors
    }
    
    // Clear deltas
    try {
      const deltas = await readdir(this.deltaDir);
      for (const file of deltas) {
        await unlink(path.join(this.deltaDir, file));
      }
    } catch (error) {
      // Ignore errors
    }
  }
  
  /**
   * Clean up old snapshots, keeping only the most recent maxSnapshots.
   * Also prunes deltas older than the oldest retained snapshot and
   * frame buckets not referenced by any retained snapshot.
   */
  private async cleanupOldSnapshots() {
    if (this.maxSnapshots <= 0) return;

    try {
      const files = await readdir(this.snapshotDir);
      const snapshotFiles = files
        .filter(f => f.startsWith('snapshot-') && f.endsWith('.json') && !f.endsWith('.tmp'))
        .sort((a, b) => {
          // Sort by timestamp (newest first)
          const aMatch = a.match(/snapshot-\d+-(?:\w+-)?(\d+)\.json/);
          const bMatch = b.match(/snapshot-\d+-(?:\w+-)?(\d+)\.json/);
          const aTime = aMatch ? parseInt(aMatch[1]) : 0;
          const bTime = bMatch ? parseInt(bMatch[1]) : 0;
          return bTime - aTime; // newest first
        });

      if (snapshotFiles.length <= this.maxSnapshots) return;

      const toDelete = snapshotFiles.slice(this.maxSnapshots);
      const retained = snapshotFiles.slice(0, this.maxSnapshots);

      // Find oldest retained snapshot's sequence for delta pruning
      let oldestRetainedSequence = Infinity;
      for (const file of retained) {
        const seqMatch = file.match(/snapshot-(\d+)-/);
        if (seqMatch) {
          oldestRetainedSequence = Math.min(oldestRetainedSequence, parseInt(seqMatch[1]));
        }
      }

      // Delete old snapshot files
      for (const file of toDelete) {
        await unlink(path.join(this.snapshotDir, file));
      }
      console.log(`[FileStorageAdapter] Cleaned up ${toDelete.length} old snapshots (retained ${retained.length})`);

      // Prune deltas older than the oldest retained snapshot
      if (oldestRetainedSequence < Infinity) {
        await this.pruneOldDeltas(oldestRetainedSequence);
      }

      // Prune orphaned frame buckets
      await this.pruneOrphanedBuckets(retained);
    } catch (error) {
      console.error('[FileStorageAdapter] Error cleaning up old snapshots:', error);
    }
  }

  /**
   * Delete delta files with sequence < minSequence (unreplayable without their base snapshot).
   */
  private async pruneOldDeltas(minSequence: number): Promise<void> {
    try {
      const files = await readdir(this.deltaDir);
      let pruned = 0;
      for (const file of files) {
        const match = file.match(/delta-(\d+)\.json/);
        if (!match) continue;
        const seq = parseInt(match[1]);
        if (seq < minSequence) {
          await unlink(path.join(this.deltaDir, file));
          pruned++;
        }
      }
      if (pruned > 0) {
        console.log(`[FileStorageAdapter] Pruned ${pruned} deltas older than sequence ${minSequence}`);
      }
    } catch (error) {
      console.error('[FileStorageAdapter] Error pruning old deltas:', error);
    }
  }

  /**
   * Delete frame bucket files not referenced by any of the retained snapshots.
   */
  private async pruneOrphanedBuckets(retainedSnapshotFiles: string[]): Promise<void> {
    try {
      // Collect all bucket hashes referenced by retained snapshots
      const referencedHashes = new Set<string>();
      for (const file of retainedSnapshotFiles) {
        const filepath = path.join(this.snapshotDir, file);
        const data = await readFile(filepath, 'utf-8');
        const snapshot = JSON.parse(data);
        const refs = snapshot.veilState?.frameBucketRefs || [];
        for (const ref of refs) {
          if (ref.hash) referencedHashes.add(ref.hash);
        }
      }

      if (referencedHashes.size === 0) return;

      // Walk frame-buckets directory and delete unreferenced ones
      const bucketsDir = path.join(this.basePath, 'frame-buckets');
      let pruned = 0;
      try {
        const dirs = await readdir(bucketsDir);
        for (const dir of dirs) {
          const dirPath = path.join(bucketsDir, dir);
          // Skip non-directories (2-char hash prefix dirs)
          try {
            const stat = await promisify(fs.stat)(dirPath);
            if (!stat.isDirectory()) continue;
          } catch { continue; }

          const bucketFiles = await readdir(dirPath);
          for (const bucketFile of bucketFiles) {
            // Reconstruct full hash: dir prefix + filename without .json
            const hash = dir + bucketFile.replace('.json', '');
            if (!referencedHashes.has(hash)) {
              await unlink(path.join(dirPath, bucketFile));
              pruned++;
            }
          }
        }
      } catch {
        // frame-buckets dir might not exist
      }

      if (pruned > 0) {
        console.log(`[FileStorageAdapter] Pruned ${pruned} orphaned frame buckets`);
      }
    } catch (error) {
      console.error('[FileStorageAdapter] Error pruning orphaned buckets:', error);
    }
  }
  
  /**
   * Load frame history from ALL snapshots on disk, not just the latest.
   * Collects bucket refs across all snapshots, deduplicates, and loads
   * up to maxFrames (keeping the newest).
   *
   * When minFramesPerStream > 0, performs a two-pass load:
   *  1. Load newest maxFrames globally (existing behavior)
   *  2. Check which streams are below the minimum message frame count
   *  3. Load additional older buckets that contain those streams
   */
  async loadFullFrameHistory(maxFrames: number, minFramesPerStream: number = 0): Promise<Frame[]> {
    const allRefs = new Map<string, FrameBucketRef>();

    try {
      const files = await readdir(this.snapshotDir);
      const snapshotFiles = files.filter(f =>
        f.startsWith('snapshot-') && f.endsWith('.json') && !f.endsWith('.tmp')
      );

      for (const file of snapshotFiles) {
        try {
          const filepath = path.join(this.snapshotDir, file);
          const data = await readFile(filepath, 'utf-8');
          const snapshot = JSON.parse(data);
          const refs: FrameBucketRef[] = snapshot.veilState?.frameBucketRefs || [];
          for (const ref of refs) {
            if (ref.hash && !allRefs.has(ref.hash)) {
              allRefs.set(ref.hash, ref);
            }
          }
        } catch {
          // Skip unreadable snapshots
        }
      }
    } catch {
      return [];
    }

    if (allRefs.size === 0) return [];

    // Sort refs by startSequence ascending
    const sortedRefs = Array.from(allRefs.values())
      .sort((a, b) => a.startSequence - b.startSequence);

    // Pass 1: Select refs to load (keep newest up to maxFrames)
    const totalAvailable = sortedRefs.reduce((sum, ref) => sum + ref.frameCount, 0);
    const loadedRefHashes = new Set<string>();
    let refsToLoad: FrameBucketRef[];
    if (totalAvailable <= maxFrames) {
      refsToLoad = sortedRefs;
    } else {
      refsToLoad = [];
      let accumulated = 0;
      for (let i = sortedRefs.length - 1; i >= 0; i--) {
        refsToLoad.unshift(sortedRefs[i]);
        accumulated += sortedRefs[i].frameCount;
        if (accumulated >= maxFrames) break;
      }
    }
    for (const ref of refsToLoad) loadedRefHashes.add(ref.hash);

    console.log(`[FileStorageAdapter] Loading full frame history: ${refsToLoad.length} buckets from ${allRefs.size} unique across all snapshots`);

    let frames = await this.bucketStore.loadFrames(refsToLoad);

    // Pass 2: Per-stream backfill — load older buckets for streams below minimum
    if (minFramesPerStream > 0) {
      const MESSAGE_TYPES = new Set(['event', 'speech', 'thought', 'action']);

      // Count message frames per stream in what we loaded
      const streamCounts = new Map<string, number>();
      for (const frame of frames) {
        const sid = frame.activeStream?.streamId;
        if (!sid) continue;
        for (const delta of frame.deltas || []) {
          if (delta.type === 'addFacet' && delta.facet && MESSAGE_TYPES.has((delta.facet as any).type)) {
            streamCounts.set(sid, (streamCounts.get(sid) || 0) + 1);
            break;
          }
        }
      }

      // Find streams below minimum (includes streams with zero frames in initial load)
      const deficientStreams = new Set<string>();
      for (const [sid, count] of streamCounts) {
        if (count < minFramesPerStream) deficientStreams.add(sid);
      }

      // Also discover streams that exist in older buckets but have zero frames
      // in the initial load — these are completely invisible without backfill
      const olderRefs = sortedRefs.filter(r => !loadedRefHashes.has(r.hash));
      for (const ref of olderRefs) {
        if (ref.streamIds) {
          for (const sid of ref.streamIds) {
            if (!streamCounts.has(sid)) {
              deficientStreams.add(sid);
            }
          }
        }
      }

      if (deficientStreams.size > 0) {
        // Find older buckets that might contain deficient streams.
        // Check streamIds metadata first; fall back to scanning bucket content.
        const backfillRefs: FrameBucketRef[] = [];

        for (const ref of olderRefs) {
          if (ref.streamIds) {
            // New-format bucket: has stream index metadata
            const hasDeficient = ref.streamIds.some(sid => deficientStreams.has(sid));
            if (hasDeficient) backfillRefs.push(ref);
          } else {
            // Old-format bucket: no metadata, must scan. Load it speculatively.
            backfillRefs.push(ref);
          }
        }

        if (backfillRefs.length > 0) {
          console.log(`[FileStorageAdapter] Per-stream backfill: ${deficientStreams.size} streams below min ${minFramesPerStream}, loading ${backfillRefs.length} older buckets`);
          const backfillFrames = await this.bucketStore.loadFrames(backfillRefs);

          // Sort newest-first so we keep the most recent history per stream
          backfillFrames.sort((a, b) => b.sequence - a.sequence);

          // First pass: discover any new streams in old-format buckets that weren't
          // in the initial load or in streamIds metadata. Add them to deficientStreams.
          for (const frame of backfillFrames) {
            const sid = frame.activeStream?.streamId;
            if (!sid || streamCounts.has(sid) || deficientStreams.has(sid)) continue;
            for (const delta of frame.deltas || []) {
              if (delta.type === 'addFacet' && delta.facet && MESSAGE_TYPES.has((delta.facet as any).type)) {
                deficientStreams.add(sid);
                break;
              }
            }
          }

          // Second pass: keep message frames from deficient streams (newest first)
          let kept = 0;
          for (const frame of backfillFrames) {
            const sid = frame.activeStream?.streamId;
            if (!sid || !deficientStreams.has(sid)) continue;

            let isMessage = false;
            for (const delta of frame.deltas || []) {
              if (delta.type === 'addFacet' && delta.facet && MESSAGE_TYPES.has((delta.facet as any).type)) {
                isMessage = true;
                break;
              }
            }
            if (!isMessage) continue;

            frames.push(frame);
            kept++;
            const newCount = (streamCounts.get(sid) || 0) + 1;
            streamCounts.set(sid, newCount);
            if (newCount >= minFramesPerStream) {
              deficientStreams.delete(sid);
            }
          }
          console.log(`[FileStorageAdapter] Per-stream backfill: kept ${kept} message frames, ${deficientStreams.size} streams still below min`);
        }
      }
    }

    // Deduplicate by sequence (overlapping bucket boundaries can cause duplicates)
    const frameMap = new Map<number, Frame>();
    for (const frame of frames) {
      frameMap.set(frame.sequence, frame);
    }
    const deduped = Array.from(frameMap.values())
      .sort((a, b) => a.sequence - b.sequence);

    // Don't trim to maxFrames here — let VEILStateManager.trimFrameHistory handle
    // the per-stream-aware trimming after restore
    return deduped;
  }

  /**
   * Compress a delta
   */
  private async compressDelta(delta: FrameDelta): Promise<string> {
    // TODO: Implement compression (e.g., using zlib)
    return JSON.stringify(delta);
  }
  
  /**
   * Decompress a delta
   */
  private async decompressDelta(data: string): Promise<FrameDelta> {
    // TODO: Implement decompression
    return JSON.parse(data);
  }
  
  private config?: { compressDeltas?: boolean };
  
  /**
   * Write a file to a relative path
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.basePath, relativePath);
    
    // Wait for any existing write to this file to complete
    const existingWrite = this.writeLocks.get(fullPath);
    if (existingWrite) {
      console.log(`[FileStorageAdapter] Waiting for existing write to complete: ${relativePath}`);
      await existingWrite;
    }
    
    // Create a new write promise
    const writePromise = this.performWrite(fullPath, content);
    this.writeLocks.set(fullPath, writePromise);
    
    try {
      await writePromise;
    } finally {
      // Clean up the lock
      this.writeLocks.delete(fullPath);
    }
  }
  
  private async performWrite(fullPath: string, content: string): Promise<void> {
    const dir = path.dirname(fullPath);
    
    // Ensure directory exists
    await mkdir(dir, { recursive: true });
    
    // Write atomically by writing to a temp file first
    const tempPath = `${fullPath}.tmp`;
    await writeFile(tempPath, content);
    
    // Rename to final location (atomic on most filesystems)
    await promisify(fs.rename)(tempPath, fullPath);
  }
  
  /**
   * Read a file from a relative path
   */
  async readFile(relativePath: string): Promise<string> {
    const fullPath = path.join(this.basePath, relativePath);
    return readFile(fullPath, 'utf-8');
  }
  
  /**
   * List files in a directory
   */
  async listFiles(relativePath: string): Promise<string[]> {
    const fullPath = path.join(this.basePath, relativePath);
    console.log('[FileStorageAdapter] Listing files in:', fullPath);
    try {
      const files = await readdir(fullPath);
      console.log('[FileStorageAdapter] Found files:', files);
      return files;
    } catch (error) {
      console.log('[FileStorageAdapter] Error listing files:', error);
      return [];
    }
  }
  
  /**
   * Delete a file
   */
  async deleteFile(relativePath: string): Promise<void> {
    const fullPath = path.join(this.basePath, relativePath);
    try {
      await unlink(fullPath);
      console.log('[FileStorageAdapter] Deleted file:', fullPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, that's okay
        console.log('[FileStorageAdapter] File not found (already deleted?):', fullPath);
        return;
      }
      console.error('[FileStorageAdapter] Error deleting file:', error);
      throw error;
    }
  }
}
