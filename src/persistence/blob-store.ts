/**
 * BlobStore — content-addressed binary store, parallel persistence primitive
 * alongside the frame log and snapshots.
 *
 * Bytes are addressed by sha256(content). Same content → same id → free dedup
 * across the entire archive. Files are written once, atomically, and never
 * mutated in place. Crash-safe via tmp-file + rename.
 *
 * Layout under `<basePath>/blobs/`:
 *   blobs/
 *     ab/
 *       abc123...def.json    # metadata sidecar (contentType, filename, size)
 *       abc123...def.bin     # raw bytes
 *       abc123...def.bin.tmp # in-flight write (orphaned tmps GC'd on init)
 *
 * Metadata is stored separately so GetBlob can serve a header without reading
 * the full bytes off disk.
 *
 * This is a **living archive** primitive: blobs are never deleted by the
 * store. Garbage collection / tiered storage are out of scope for phase 1.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);
const stat = promisify(fs.stat);
const rename = promisify(fs.rename);
const readdir = promisify(fs.readdir);

export interface BlobMetadata {
  contentType: string;
  filename: string;
  sizeBytes: number;
  firstSeenAt: number;  // ms epoch — when this blob was first written
}

export interface PutBlobResult {
  blobId: string;
  sizeBytes: number;
  alreadyExisted: boolean;
}

export interface GetBlobResult {
  blobId: string;
  sizeBytes: number;
  contentType: string;
  filename: string;
  bytes: Uint8Array;
}

export interface BlobStoreConfig {
  /** Base persistence dir (blob store lives at `<basePath>/blobs/`) */
  basePath: string;
}

export class BlobStore {
  private readonly blobsDir: string;
  private initialized = false;

  constructor(config: BlobStoreConfig) {
    this.blobsDir = path.join(config.basePath, 'blobs');
  }

  /**
   * Ensure the blobs directory exists and clean up any orphaned .tmp files
   * from crashed mid-writes. Idempotent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.blobsDir, { recursive: true });
    await this.cleanupTempFiles();
    this.initialized = true;
    console.log(`[BlobStore] Initialized at ${this.blobsDir}`);
  }

  /**
   * Store bytes. Returns the sha256 content-addressed id.
   * Idempotent: storing the same bytes twice is a no-op (alreadyExisted=true).
   *
   * Write path is crash-safe:
   *   1. Compute sha256
   *   2. If blob file already exists for this sha → return alreadyExisted=true
   *   3. Write bytes to `<sha>.bin.tmp`
   *   4. Write metadata to `<sha>.json.tmp`
   *   5. Atomic-rename both .tmp → final names (POSIX rename is atomic)
   *
   * Crash between steps 3 and 5 leaves orphaned .tmp files; cleanupTempFiles()
   * sweeps them on next initialize().
   */
  async putBlob(
    bytes: Uint8Array,
    meta: { contentType: string; filename?: string }
  ): Promise<PutBlobResult> {
    await this.initialize();

    const blobId = this.computeSha256(bytes);
    const paths = this.pathsFor(blobId);

    // Dedup: if the data file already exists, this is a no-op
    if (await this.fileExists(paths.dataPath)) {
      return { blobId, sizeBytes: bytes.length, alreadyExisted: true };
    }

    // Ensure shard dir exists
    await mkdir(path.dirname(paths.dataPath), { recursive: true });

    // Write data .tmp then metadata .tmp
    const dataTmp = paths.dataPath + '.tmp';
    const metaTmp = paths.metaPath + '.tmp';
    const metadata: BlobMetadata = {
      contentType: meta.contentType,
      filename: meta.filename || '',
      sizeBytes: bytes.length,
      firstSeenAt: Date.now()
    };

    try {
      await writeFile(dataTmp, bytes);
      await writeFile(metaTmp, JSON.stringify(metadata));
      // Atomic-rename data first, then metadata. If we crash between, the
      // metadata-less blob is detectable on read and can be reconstructed.
      await rename(dataTmp, paths.dataPath);
      await rename(metaTmp, paths.metaPath);
    } catch (err) {
      // Best-effort cleanup of any tmp we created
      await unlink(dataTmp).catch(() => {});
      await unlink(metaTmp).catch(() => {});
      throw err;
    }

    console.log(`[BlobStore] Put blob ${blobId.substring(0, 12)}... (${bytes.length} bytes, ${meta.contentType})`);
    return { blobId, sizeBytes: bytes.length, alreadyExisted: false };
  }

  /**
   * Retrieve a blob by its sha256 id. Throws if not found.
   */
  async getBlob(blobId: string): Promise<GetBlobResult> {
    await this.initialize();

    if (!this.isValidBlobId(blobId)) {
      throw new Error(`BlobStore: invalid blob_id format: ${blobId}`);
    }

    const paths = this.pathsFor(blobId);

    if (!(await this.fileExists(paths.dataPath))) {
      throw new Error(`BlobStore: blob not found: ${blobId}`);
    }

    const bytes = await readFile(paths.dataPath);

    // Metadata is best-effort — if missing (legacy or crash), synthesize
    let metadata: BlobMetadata;
    if (await this.fileExists(paths.metaPath)) {
      try {
        metadata = JSON.parse(await readFile(paths.metaPath, 'utf-8'));
      } catch {
        metadata = {
          contentType: 'application/octet-stream',
          filename: '',
          sizeBytes: bytes.length,
          firstSeenAt: 0
        };
      }
    } else {
      metadata = {
        contentType: 'application/octet-stream',
        filename: '',
        sizeBytes: bytes.length,
        firstSeenAt: 0
      };
    }

    return {
      blobId,
      sizeBytes: bytes.length,
      contentType: metadata.contentType,
      filename: metadata.filename,
      bytes: new Uint8Array(bytes)
    };
  }

  /**
   * Check whether a blob exists without reading its bytes.
   */
  async hasBlob(blobId: string): Promise<boolean> {
    await this.initialize();
    if (!this.isValidBlobId(blobId)) return false;
    const paths = this.pathsFor(blobId);
    return this.fileExists(paths.dataPath);
  }

  /**
   * Read only metadata (no bytes). Returns null if blob doesn't exist.
   */
  async getBlobMetadata(blobId: string): Promise<BlobMetadata | null> {
    await this.initialize();
    if (!this.isValidBlobId(blobId)) return null;
    const paths = this.pathsFor(blobId);
    if (!(await this.fileExists(paths.metaPath))) {
      // Blob may exist without metadata sidecar — fall back to data file stat
      if (await this.fileExists(paths.dataPath)) {
        const s = await stat(paths.dataPath);
        return {
          contentType: 'application/octet-stream',
          filename: '',
          sizeBytes: s.size,
          firstSeenAt: 0
        };
      }
      return null;
    }
    try {
      return JSON.parse(await readFile(paths.metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Sweep orphaned .tmp files left by crashed putBlob() calls.
   * Called automatically on init().
   */
  async cleanupTempFiles(): Promise<void> {
    let removed = 0;
    try {
      const shards = await readdir(this.blobsDir);
      for (const shard of shards) {
        const shardPath = path.join(this.blobsDir, shard);
        try {
          const s = await stat(shardPath);
          if (!s.isDirectory()) continue;
        } catch { continue; }

        let entries: string[];
        try {
          entries = await readdir(shardPath);
        } catch { continue; }

        for (const entry of entries) {
          if (entry.endsWith('.tmp')) {
            await unlink(path.join(shardPath, entry)).catch(() => {});
            removed++;
          }
        }
      }
    } catch {
      // blobs dir doesn't exist yet — no work to do
    }
    if (removed > 0) {
      console.log(`[BlobStore] Cleaned up ${removed} orphaned .tmp files`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private computeSha256(bytes: Uint8Array): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * Validate that a string looks like a sha256 hex digest (64 lowercase hex chars).
   * Defends against path traversal and accidental garbage IDs.
   */
  private isValidBlobId(blobId: string): boolean {
    return typeof blobId === 'string' && /^[0-9a-f]{64}$/.test(blobId);
  }

  /**
   * Compute on-disk paths for a blob:
   *   shard = first 2 chars of sha
   *   data  = <blobs>/<shard>/<sha>.bin
   *   meta  = <blobs>/<shard>/<sha>.json
   */
  private pathsFor(blobId: string): { dataPath: string; metaPath: string } {
    const shard = blobId.substring(0, 2);
    return {
      dataPath: path.join(this.blobsDir, shard, `${blobId}.bin`),
      metaPath: path.join(this.blobsDir, shard, `${blobId}.json`)
    };
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }
}
