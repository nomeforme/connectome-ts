#!/usr/bin/env node
/**
 * Connectome gRPC Server Entry Point
 * Starts the Connectome host with gRPC server enabled
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import { initErrorTracking, Sentry } from '@connectome/grpc-common';
initErrorTracking({ serviceName: 'connectome' });

import { ConnectomeHost } from './host/host.js';
import { Space } from './spaces/space.js';
import { VEILStateManager } from './veil/veil-state.js';
import { AnthropicProvider } from './llm/anthropic-provider.js';
import { startGrpcServer } from './grpc/server.js';
import type { ConnectomeApplication } from './host/types.js';
import { ComponentRegistry } from './persistence/component-registry.js';

/**
 * Configuration from environment variables
 */
interface GrpcConfig {
  grpcPort: number;
  grpcHost: string;
  persistenceEnabled: boolean;
  persistenceDir: string;
  snapshotInterval: number;
  debugEnabled: boolean;
  debugPort: number;
  reset: boolean;
}

/**
 * Load configuration from environment
 */
function loadConfig(): GrpcConfig {
  return {
    grpcPort: parseInt(process.env.GRPC_PORT || '50051'),
    grpcHost: process.env.GRPC_HOST || '0.0.0.0',
    persistenceEnabled: process.env.PERSISTENCE_ENABLED !== 'false',
    persistenceDir: process.env.PERSISTENCE_DIR || './connectome-state',
    snapshotInterval: parseInt(process.env.SNAPSHOT_INTERVAL || '1000'),
    debugEnabled: process.env.DEBUG_ENABLED === 'true',
    debugPort: parseInt(process.env.DEBUG_PORT || '3015'),
    reset: process.argv.includes('--reset')
  };
}

/**
 * Minimal Connectome application for gRPC server mode
 * Provides the core Space and VEIL state without any specific adapters
 */
class GrpcServerApplication implements ConnectomeApplication {
  namespace = 'grpc-server';

  async createSpace(
    hostRegistry?: Map<string, any>,
    lifecycleId?: string,
    spaceId?: string
  ): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry, lifecycleId, spaceId || 'grpc-root');
    return { space, veilState };
  }

  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('[GrpcServer] Initializing minimal Space...');
    // The gRPC server is a pure communication layer.
    // All application-specific components (receptors, transforms, effectors)
    // should be implemented in the axon clients (discord-axon, signal-axon).
    // The server just maintains VEIL state and routes events/facets.
    console.log('[GrpcServer] Minimal Space initialized (no application components)');
  }

  getComponentRegistry() {
    // Return minimal registry
    return ComponentRegistry;
  }

  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('[GrpcServer] Core Space started');

    // Emit a system init event
    space.emit({
      topic: 'system:grpc-ready',
      source: {
        componentId: 'grpc-server',
        componentPath: ['grpc', 'server']
      },
      payload: { ready: true },
      timestamp: Date.now()
    });
  }

  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('[GrpcServer] Core Space restored from persistence');
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     CONNECTOME gRPC SERVER                             ║');
  console.log('║     Central state and agent orchestration service      ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  const config = loadConfig();

  console.log('Configuration:');
  console.log(`  gRPC Port:     ${config.grpcPort}`);
  console.log(`  gRPC Host:     ${config.grpcHost}`);
  console.log(`  Persistence:   ${config.persistenceEnabled ? config.persistenceDir : 'disabled'}`);
  console.log(`  Debug UI:      ${config.debugEnabled ? `http://localhost:${config.debugPort}` : 'disabled'}`);
  console.log(`  Reset:         ${config.reset}`);
  console.log();

  // Create LLM provider if API key is available
  const providers: Record<string, any> = {};
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    providers['llm.primary'] = new AnthropicProvider({
      apiKey,
      defaultMaxTokens: 4096
    });
    console.log('✓ Anthropic LLM provider configured');
  } else {
    console.warn('⚠ No ANTHROPIC_API_KEY - LLM features will be unavailable');
  }

  // Create the host
  const host = new ConnectomeHost({
    persistence: {
      enabled: config.persistenceEnabled,
      storageDir: config.persistenceDir,
      snapshotInterval: config.snapshotInterval
    },
    debug: {
      enabled: config.debugEnabled,
      port: config.debugPort
    },
    providers,
    reset: config.reset
  });

  // Create the application
  const app = new GrpcServerApplication();

  // Track space for gRPC server
  let space: Space;
  let grpcServer: any;

  // Handle shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n\n[${signal}] Shutting down gracefully...`);

    try {
      // Stop gRPC server first
      if (grpcServer) {
        console.log('  Stopping gRPC server...');
        await grpcServer.stop();
      }

      // Stop host (saves persistence)
      console.log('  Saving state and stopping host...');
      await host.stop();

      // Flush pending error tracking events
      await Sentry.flush(2000);

      console.log('✓ Shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('✗ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Start the host
    console.log('Starting Connectome host...');
    space = await host.start(app);

    // Start gRPC server
    console.log('Starting gRPC server...');
    grpcServer = await startGrpcServer({
      port: config.grpcPort,
      host: config.grpcHost,
      space,
      veilState: space.getVEILState()
    });

    console.log();
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  gRPC server listening on ${config.grpcHost}:${config.grpcPort}`);
    if (config.debugEnabled) {
      console.log(`  Debug UI available at http://localhost:${config.debugPort}`);
    }
    console.log('═══════════════════════════════════════════════════════');
    console.log();
    console.log('Ready to accept connections from axon clients.');
    console.log('Press Ctrl+C to stop.\n');

  } catch (error) {
    console.error('✗ Failed to start:', error);
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
