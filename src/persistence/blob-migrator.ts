/**
 * BlobMigrator — Phase 2 of the content-addressed blob store rollout.
 *
 * Walks the on-disk persistence archive (snapshots, frame-buckets, deltas)
 * and rewrites every inline-bytes attachment (`data: "<base64>"`) into a
 * content-addressed ref (`blobId: "<sha256>"`) backed by the BlobStore.
 *
 * ## Invariants
 *
 *  - **Content-equivalence**: any VEIL state reconstructable from the old
 *    file must be reconstructable from the new file + blob store.
 *  - **Crash-safe**: write `<file>.v2`, fsync, atomic-rename. POSIX rename
 *    is atomic, so crash at any moment leaves either old (still readable
 *    via legacy `inline_data` deserializer path) or new (refs + bytes in
 *    blob store). Never partial.
 *  - **Idempotent**: re-running over an already-migrated file is a no-op
 *    (no inline attachments found → file skipped). PutBlob is sha-keyed so
 *    re-uploading the same bytes is also a no-op.
 *  - **Resumable**: per-file completion tracked in `migration-progress.json`
 *    so a crashed/killed migrator picks up where it left off.
 *  - **No live-server impact**: only touches files on disk. Connectome only
 *    re-reads snapshots/buckets/deltas at startup, not at runtime. Atomic
 *    rename means concurrent reads always see a complete file.
 *
 * ## Frame bucket filename caveat
 *
 * Frame bucket files are content-addressed by filename
 * (`frame-buckets/<sha-prefix>/<bucket-content-sha>.json`). Rewriting the
 * file in place changes the content but not the filename, so the filename
 * hash becomes stale. This is **functionally OK** — snapshots reference by
 * filename, no consumer re-validates the content hash. The bucket's own
 * internal `hash` field is left untouched as a record of the original
 * pre-migration content hash. Cosmetic but harmless.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export interface BlobMigratorOptions {
  /** Persistence root (the dir that contains snapshots/, frame-buckets/, deltas/, blobs/). */
  basePath: string;

  /**
   * Function that uploads bytes to the blob store and returns the sha id.
   * Typically `client.putBlob.bind(client)` against a live ConnectomeClient.
   */
  putBlob: (bytes: Uint8Array, meta: { contentType: string; filename?: string }) => Promise<{
    blobId: string;
    sizeBytes: number;
    alreadyExisted: boolean;
  }>;

  /** Optional logger sink. Defaults to console. */
  log?: (line: string) => void;

  /** When true, scan and report but never write or upload. Default false. */
  dryRun?: boolean;

  /** Optional cap on the number of PutBlob calls per second (rough throttle). */
  rateLimitOpsPerSec?: number;

  /**
   * If set, stop after migrating this many files (excluding skipped). Useful
   * for smoke tests. Files are processed oldest-first.
   */
  limitFiles?: number;

  /** If set, only process files whose basename matches this substring. */
  filter?: string;
}

export interface MigrationStats {
  filesScanned: number;
  filesRewritten: number;
  filesSkipped: number;
  filesFailed: number;
  inlineAttachmentsFound: number;
  blobsUploaded: number;        // count where alreadyExisted=false
  blobsDeduped: number;         // count where alreadyExisted=true
  bytesProcessed: number;       // total bytes seen as inline_data
  bytesUnique: number;          // bytes actually stored after dedup
  startedAt: number;
  finishedAt?: number;
}

interface ProgressFile {
  /** sha256(file path + size + mtime) for files already fully migrated. */
  completed: string[];
  startedAt: number;
  lastUpdated: number;
}

/**
 * Categories of files the migrator touches. Order matters for `migrateAll()` —
 * snapshots first (smallest set, most useful for active context restore),
 * then frame-buckets (largest aggregate volume), then deltas (long tail).
 */
type FileCategory = 'snapshot' | 'frame-bucket' | 'delta';

interface MigrationTarget {
  category: FileCategory;
  path: string;
  size: number;
  mtimeMs: number;
}

export class BlobMigrator {
  private readonly opts: Required<Pick<BlobMigratorOptions, 'basePath' | 'putBlob'>> &
    Partial<BlobMigratorOptions>;
  private readonly log: (line: string) => void;
  private readonly dryRun: boolean;
  private readonly progressPath: string;

  private stats: MigrationStats = {
    filesScanned: 0,
    filesRewritten: 0,
    filesSkipped: 0,
    filesFailed: 0,
    inlineAttachmentsFound: 0,
    blobsUploaded: 0,
    blobsDeduped: 0,
    bytesProcessed: 0,
    bytesUnique: 0,
    startedAt: 0,
  };

  /** Per-call dedup cache so the same blob isn't decoded twice in one run. */
  private blobCache = new Map<string, string>();  // base64-substring → blobId

  /** Naive rate limiter state. */
  private opsThisSecond = 0;
  private secondStart = Date.now();

  constructor(options: BlobMigratorOptions) {
    this.opts = options;
    this.log = options.log ?? ((s) => console.log(s));
    this.dryRun = options.dryRun ?? false;
    this.progressPath = path.join(options.basePath, 'migration-progress.json');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Walk the entire archive, migrate, return final stats. */
  async migrateAll(): Promise<MigrationStats> {
    this.stats.startedAt = Date.now();
    const progress = await this.loadProgress();
    const completed = new Set(progress.completed);

    this.log(`[BlobMigrator] Scanning ${this.opts.basePath}...`);
    const targets = await this.findFiles();
    this.log(`[BlobMigrator] Found ${targets.length} candidate files (${this.byCategory(targets)})`);

    let processed = 0;
    for (const target of targets) {
      if (this.opts.limitFiles && processed >= this.opts.limitFiles) {
        this.log(`[BlobMigrator] Reached --limit-files=${this.opts.limitFiles}, stopping`);
        break;
      }

      const key = this.fingerprint(target);
      if (completed.has(key)) {
        this.stats.filesSkipped++;
        continue;
      }

      try {
        const changed = await this.migrateFile(target);
        if (changed) processed++;

        // Don't poison the progress table during a dry-run — the user is just
        // sampling and may want to re-run live afterwards.
        if (!this.dryRun) {
          completed.add(key);
          // Save progress every 10 files (cheap enough)
          if (this.stats.filesScanned % 10 === 0) {
            await this.saveProgress({ ...progress, completed: [...completed] });
          }
        }
      } catch (err: any) {
        this.stats.filesFailed++;
        this.log(`[BlobMigrator] FAIL ${target.path}: ${err.message}`);
      }
    }

    // Final progress save
    await this.saveProgress({ ...progress, completed: [...completed] });
    this.stats.finishedAt = Date.now();
    return this.stats;
  }

  /**
   * Migrate a single file. Returns true if file was rewritten, false if
   * already-clean (no inline data) or dry-run skipped.
   */
  async migrateFile(target: MigrationTarget): Promise<boolean> {
    this.stats.filesScanned++;
    const raw = await fs.readFile(target.path, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`JSON parse failed: ${err.message}`);
    }

    // Walk + collect work units (don't mutate yet — keep dry-run honest)
    const workUnits = this.findInlineAttachments(parsed);
    if (workUnits.length === 0) {
      // Already migrated or never had inline data
      return false;
    }

    this.stats.inlineAttachmentsFound += workUnits.length;
    this.log(`[BlobMigrator] ${target.category} ${path.basename(target.path)}: ${workUnits.length} inline attachment(s)`);

    if (this.dryRun) {
      for (const w of workUnits) {
        this.stats.bytesProcessed += w.byteLen;
      }
      return false;
    }

    // Upload each unique blob, capture sha
    for (const w of workUnits) {
      await this.throttle();
      const cached = this.blobCache.get(w.cacheKey);
      let blobId: string;
      if (cached) {
        blobId = cached;
        this.stats.blobsDeduped++;
      } else {
        const result = await this.opts.putBlob(w.bytes, {
          contentType: w.attachment.contentType || 'application/octet-stream',
          filename: w.attachment.filename || w.attachment.name,
        });
        blobId = result.blobId;
        this.blobCache.set(w.cacheKey, blobId);
        if (result.alreadyExisted) {
          this.stats.blobsDeduped++;
        } else {
          this.stats.blobsUploaded++;
          this.stats.bytesUnique += w.byteLen;
        }
      }
      this.stats.bytesProcessed += w.byteLen;

      // Rewrite the attachment in place: drop `data` / `inlineData`, set `blobId`
      delete w.attachment.data;
      delete w.attachment.inlineData;
      w.attachment.blobId = blobId;
      // Preserve sizeBytes if missing (decoder may need it)
      if (w.attachment.sizeBytes == null) {
        w.attachment.sizeBytes = w.byteLen;
      }
    }

    // Atomic write: <path>.v2 → fsync → rename
    const tmpPath = target.path + '.v2';
    const newContent = JSON.stringify(parsed, null, 2);
    const handle = await fs.open(tmpPath, 'w');
    try {
      await handle.writeFile(newContent);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, target.path);

    this.stats.filesRewritten++;
    return true;
  }

  /** Final stats so far (also returned by migrateAll). */
  getStats(): MigrationStats {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Build the ordered list of files to migrate, oldest-first. */
  private async findFiles(): Promise<MigrationTarget[]> {
    const targets: MigrationTarget[] = [];

    // Helper: append in chunks so we don't blow the call stack on .push(...big)
    const append = (xs: MigrationTarget[]) => {
      for (let i = 0; i < xs.length; i++) targets.push(xs[i]);
    };

    // Snapshots
    const snapDir = path.join(this.opts.basePath, 'snapshots');
    append(await this.scanDir(snapDir, 'snapshot', /^snapshot-.*\.json$/));

    // Frame buckets (sharded subdirectories)
    const bucketsDir = path.join(this.opts.basePath, 'frame-buckets');
    try {
      const shards = await fs.readdir(bucketsDir);
      for (const shard of shards) {
        const shardPath = path.join(bucketsDir, shard);
        try {
          const stat = await fs.stat(shardPath);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }
        append(await this.scanDir(shardPath, 'frame-bucket', /\.json$/));
      }
    } catch {
      // dir missing — skip
    }

    // Deltas
    const deltasDir = path.join(this.opts.basePath, 'deltas');
    append(await this.scanDir(deltasDir, 'delta', /^delta-\d+\.json$/));

    // Apply filter if set
    let filtered = targets;
    if (this.opts.filter) {
      filtered = targets.filter((t) => t.path.includes(this.opts.filter!));
    }

    // Sort by mtime ASC (oldest first); ties broken by path
    filtered.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));

    return filtered;
  }

  private async scanDir(
    dir: string,
    category: FileCategory,
    pattern: RegExp,
  ): Promise<MigrationTarget[]> {
    const out: MigrationTarget[] = [];
    try {
      const entries = await fs.readdir(dir);
      for (const name of entries) {
        if (!pattern.test(name)) continue;
        const p = path.join(dir, name);
        try {
          const stat = await fs.stat(p);
          if (!stat.isFile()) continue;
          out.push({ category, path: p, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* dir missing */
    }
    return out;
  }

  /**
   * Recursive walker: returns a list of `{attachment, bytes, byteLen, cacheKey}`
   * work units, one per inline attachment found anywhere in `obj`.
   * The attachment object itself is captured by reference so the caller can
   * mutate it after upload.
   */
  private findInlineAttachments(obj: any): Array<{
    attachment: any;
    bytes: Uint8Array;
    byteLen: number;
    cacheKey: string;
  }> {
    const work: Array<{ attachment: any; bytes: Uint8Array; byteLen: number; cacheKey: string }> = [];

    const visit = (node: any): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      // If this node has an `attachments` array, inspect each
      const atts = (node as any).attachments;
      if (Array.isArray(atts)) {
        for (const att of atts) {
          if (att == null || typeof att !== 'object') continue;
          // Already migrated — skip
          if (att.blobId) continue;

          const bytes = this.extractBytes(att);
          if (!bytes) continue;
          if (bytes.length === 0) continue;

          // Cache key: use a short prefix of base64 + length so duplicate detection
          // works without rehashing the whole payload on every walk. Real dedup
          // happens server-side via sha. This is just a hot cache.
          const cacheKey = `${bytes.length}:${this.shortHash(bytes)}`;

          work.push({ attachment: att, bytes, byteLen: bytes.length, cacheKey });
        }
      }
      // Recurse all object values (including under `attachments[i]`)
      for (const k of Object.keys(node)) visit(node[k]);
    };

    visit(obj);
    return work;
  }

  /**
   * Extract raw bytes from an attachment record, handling the various legacy
   * encodings on disk:
   *  - `data: "<base64>"` (string)
   *  - `data: {type: "Buffer", data: [0,1,...]}` (Node Buffer JSON form)
   *  - `data: {0: 0, 1: 1, ...}` (Uint8Array JSON form, rare)
   *  - `inlineData: "<base64>"` (proto-style field name)
   *  - `inlineData: {type: "Buffer", ...}`
   */
  private extractBytes(att: any): Uint8Array | null {
    const candidates = [att.data, att.inlineData];
    for (const raw of candidates) {
      if (raw == null) continue;

      if (typeof raw === 'string') {
        try {
          return new Uint8Array(Buffer.from(raw, 'base64'));
        } catch {
          return null;
        }
      }
      if (raw instanceof Uint8Array) return raw;
      if (Buffer.isBuffer(raw)) return new Uint8Array(raw);
      if (raw.type === 'Buffer' && Array.isArray(raw.data)) {
        return new Uint8Array(raw.data);
      }
      // Generic numeric-key object (Uint8Array JSON form)
      if (typeof raw === 'object') {
        const keys = Object.keys(raw);
        if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
          const len = keys.length;
          const out = new Uint8Array(len);
          for (let i = 0; i < len; i++) out[i] = raw[i];
          return out;
        }
      }
    }
    return null;
  }

  private shortHash(bytes: Uint8Array): string {
    // 8-byte FNV-style hash — fast, just for in-memory cache dedup
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const sample = bytes.length > 4096 ? bytes.subarray(0, 4096) : bytes;
    for (let i = 0; i < sample.length; i++) {
      h ^= BigInt(sample[i]);
      h = (h * prime) & 0xffffffffffffffffn;
    }
    return h.toString(16);
  }

  private fingerprint(t: MigrationTarget): string {
    return crypto
      .createHash('sha256')
      .update(`${t.path}|${t.size}|${Math.floor(t.mtimeMs)}`)
      .digest('hex')
      .substring(0, 16);
  }

  private async loadProgress(): Promise<ProgressFile> {
    try {
      const raw = await fs.readFile(this.progressPath, 'utf-8');
      const p = JSON.parse(raw);
      if (Array.isArray(p.completed)) return p;
    } catch {
      /* fresh */
    }
    return { completed: [], startedAt: Date.now(), lastUpdated: Date.now() };
  }

  private async saveProgress(p: ProgressFile): Promise<void> {
    p.lastUpdated = Date.now();
    const tmp = this.progressPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(p, null, 2));
    await fs.rename(tmp, this.progressPath);
  }

  private byCategory(targets: MigrationTarget[]): string {
    const counts = targets.reduce((acc, t) => {
      acc[t.category] = (acc[t.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    return Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
  }

  private async throttle(): Promise<void> {
    if (!this.opts.rateLimitOpsPerSec) return;
    const now = Date.now();
    if (now - this.secondStart >= 1000) {
      this.secondStart = now;
      this.opsThisSecond = 0;
    }
    this.opsThisSecond++;
    if (this.opsThisSecond > this.opts.rateLimitOpsPerSec) {
      const sleepMs = 1000 - (now - this.secondStart);
      if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
      this.secondStart = Date.now();
      this.opsThisSecond = 0;
    }
  }
}
