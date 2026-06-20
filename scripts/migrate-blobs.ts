#!/usr/bin/env node
/**
 * CLI entrypoint for the BlobMigrator (phase 2 of the blob store rollout).
 *
 * Walks the on-disk persistence archive and rewrites inline-bytes
 * attachments into content-addressed refs via the live Connectome PutBlob
 * RPC. Safe to run alongside the live server — atomic rename + bidirectional
 * deserializer means concurrent readers always see a complete file in one
 * of the two valid formats.
 *
 * Usage:
 *   node --import tsx scripts/migrate-blobs.ts \
 *     --state-dir /path/to/connectome-state \
 *     --grpc-host localhost \
 *     --grpc-port 50051 \
 *     [--dry-run] \
 *     [--rate-limit 10] \
 *     [--limit-files 5] \
 *     [--filter <substring>] \
 *     [--reset-progress]
 */

import { ConnectomeClient } from '@connectome/grpc-common';
import { BlobMigrator } from '../src/persistence/blob-migrator.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface Args {
  stateDir: string;
  grpcHost: string;
  grpcPort: number;
  dryRun: boolean;
  noVerify: boolean;
  rateLimit?: number;
  limitFiles?: number;
  filter?: string;
  resetProgress: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = {
    stateDir: './connectome-state',
    grpcHost: 'localhost',
    grpcPort: 50051,
    dryRun: false,
    noVerify: false,
    resetProgress: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--state-dir':       a.stateDir = v;            i++; break;
      case '--grpc-host':       a.grpcHost = v;            i++; break;
      case '--grpc-port':       a.grpcPort = parseInt(v);  i++; break;
      case '--dry-run':         a.dryRun = true;                break;
      case '--no-verify':       a.noVerify = true;              break;
      case '--rate-limit':      a.rateLimit = parseInt(v); i++; break;
      case '--limit-files':     a.limitFiles = parseInt(v); i++; break;
      case '--filter':          a.filter = v;              i++; break;
      case '--reset-progress':  a.resetProgress = true;         break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (k.startsWith('--')) {
          console.error(`Unknown flag: ${k}`);
          process.exit(2);
        }
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`migrate-blobs — rewrite inline attachment bytes into blob refs

Flags:
  --state-dir <path>     Persistence root (default: ./connectome-state)
  --grpc-host <host>     Connectome host (default: localhost)
  --grpc-port <port>     Connectome port (default: 50051)
  --dry-run              Scan + report only; no uploads, no writes
  --no-verify            Skip rehydrate-and-deep-equal verify per file
                         (default: verify is ON; recommended to leave on)
  --rate-limit <N>       Cap PutBlob calls/sec (default: unlimited)
  --limit-files <N>      Stop after migrating N files (smoke-test mode)
  --filter <substring>   Only process files whose path contains this
  --reset-progress       Delete migration-progress.json and start fresh

Examples:
  # Smoke test: process one file, no writes, see what would happen
  node --import tsx scripts/migrate-blobs.ts \\
    --state-dir /var/lib/docker/volumes/connectome_connectome-state/_data \\
    --dry-run --limit-files 1

  # Real run, throttled to 5 uploads/sec
  node --import tsx scripts/migrate-blobs.ts \\
    --state-dir /workspace/connectome-ts/state \\
    --rate-limit 5
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`╔═════════════════════════════════════════════╗`);
  console.log(`║       BLOB MIGRATOR (phase 2 of blob store) ║`);
  console.log(`╚═════════════════════════════════════════════╝`);
  console.log(`State dir:   ${args.stateDir}`);
  console.log(`Connectome:  ${args.grpcHost}:${args.grpcPort}`);
  console.log(`Mode:        ${args.dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Verify:      ${args.dryRun ? 'n/a' : (args.noVerify ? 'OFF (no equivalence check)' : 'ON (rehydrate + deep-equal)')}`);
  if (args.rateLimit) console.log(`Rate limit:  ${args.rateLimit} ops/sec`);
  if (args.limitFiles) console.log(`Limit:       first ${args.limitFiles} files only`);
  if (args.filter) console.log(`Filter:      ${args.filter}`);
  console.log();

  if (args.resetProgress) {
    const p = path.join(args.stateDir, 'migration-progress.json');
    try {
      await fs.unlink(p);
      console.log(`Reset: removed ${p}`);
    } catch {
      console.log(`Reset: no existing progress file at ${p}`);
    }
  }

  // Connect to the running Connectome
  const client = new ConnectomeClient({
    host: args.grpcHost,
    port: args.grpcPort,
    clientId: `blob-migrator-${Date.now()}`,
  });

  console.log('Connecting to Connectome...');
  await client.connect();
  console.log('Connected.\n');

  const migrator = new BlobMigrator({
    basePath: args.stateDir,
    putBlob: client.putBlob.bind(client),
    getBlob: async (id: string) => (await client.getBlob(id)).bytes,
    dryRun: args.dryRun,
    verify: !args.noVerify,
    rateLimitOpsPerSec: args.rateLimit,
    limitFiles: args.limitFiles,
    filter: args.filter,
  });

  const sigHandler = async (sig: string) => {
    console.log(`\n[${sig}] Stopping gracefully — progress persisted at next file boundary.`);
    process.exit(0);
  };
  process.on('SIGINT', () => sigHandler('SIGINT'));
  process.on('SIGTERM', () => sigHandler('SIGTERM'));

  const stats = await migrator.migrateAll();

  client.disconnect();

  const durSec = ((stats.finishedAt! - stats.startedAt) / 1000).toFixed(1);
  console.log(`\n═══════════ Migration finished in ${durSec}s ═══════════`);
  console.log(`Files scanned:               ${stats.filesScanned}`);
  console.log(`Files rewritten:             ${stats.filesRewritten}`);
  console.log(`Files skipped (already done): ${stats.filesSkipped}`);
  console.log(`Files failed:                ${stats.filesFailed}`);
  console.log(`Files verify-failed:         ${stats.filesVerifyFailed}`);
  console.log(`Inline attachments found:    ${stats.inlineAttachmentsFound}`);
  console.log(`Blobs uploaded fresh:        ${stats.blobsUploaded}`);
  console.log(`Blobs dedup hits:            ${stats.blobsDeduped}`);
  console.log(`Bytes processed:             ${formatBytes(stats.bytesProcessed)}`);
  console.log(`Bytes unique (post-dedup):   ${formatBytes(stats.bytesUnique)}`);
  if (stats.bytesProcessed > 0) {
    const ratio = ((1 - stats.bytesUnique / stats.bytesProcessed) * 100).toFixed(1);
    console.log(`Dedup dividend:              ${ratio}% saved`);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
