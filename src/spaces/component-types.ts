/**
 * Component Types - Type definitions for specialized component patterns
 * 
 * Note: Most of these interfaces are historical. Modern code should use Component
 * directly with priorityConstraint() for execution ordering.
 */

import { 
  Facet, 
  Frame,
  StreamRef,
  AgentInfo,
  hasEphemeralAspect,
  VEILDelta,
  ReadonlyVEILState
} from '../veil/types';
import { createEventFacet } from '../helpers/factories';
import { SpaceEvent } from './types';
import { Component } from './component';

/**
 * Afferent: Async external system listener
 * Bridges external systems (Discord, WebSockets, etc.) to Connectome events
 * Managed by effectors, runs asynchronously
 */
export interface Afferent<TConfig = any, TCommand = any> extends Component {
  /** Initialize with configuration and context */
  initialize(context: AfferentContext<TConfig>): Promise<void>;
  
  /** Start listening/processing */
  start(): Promise<void>;
  
  /** Stop listening/processing */
  stop(graceful?: boolean): Promise<void>;
  
  /** Handle commands from effectors */
  enqueueCommand(command: TCommand): void;
  
  /** Get current status */
  getStatus(): AfferentStatus;
  
  /** Get metrics */
  getMetrics?(): AfferentMetrics;
}

/**
 * Context provided to afferents for event emission and configuration
 */
export interface AfferentContext<TConfig> {
  /** Emit events to the main loop */
  emit: (event: SpaceEvent) => void;
  
  /** Emit error events */
  emitError: (error: AfferentError) => void;
  
  /** Configuration from VEIL facet */
  config: Readonly<TConfig>;
  
  /** Afferent ID */
  afferentId: string;
}

/**
 * Afferent status information
 */
export interface AfferentStatus {
  state: 'initializing' | 'running' | 'stopping' | 'stopped' | 'error';
  lastActivity: number;
  errorCount: number;
  lastError?: string;
}

/**
 * Afferent metrics
 */
export interface AfferentMetrics {
  eventsEmitted: number;
  commandsProcessed: number;
  uptime: number;
  memoryUsage?: number;
}

/**
 * Afferent error structure
 */
export interface AfferentError {
  afferentId: string;
  afferentType: string;
  errorType: 'connection' | 'timeout' | 'processing' | 'fatal' | 'config';
  message: string;
  stack?: string;
  recoverable: boolean;
  details?: Record<string, any>;
}


/**
 * Filter for which facets a component is interested in
 */
export interface FacetFilter {
  type?: string | string[];
  aspectMatch?: Partial<{
    temporal: 'ephemeral' | 'persistent' | 'session';
    visibility: 'agent' | 'system' | 'debug';
    renderable: boolean;
  }>;
  attributeMatch?: Record<string, any>;
}

/**
 * Delta describing a facet change
 */
export interface FacetDelta {
  type: 'added' | 'changed' | 'removed';
  facet: Facet;
  oldFacet?: Facet; // For 'changed' type
}


// Re-export common types for convenience
export { SpaceEvent, Facet, Frame, VEILDelta, ReadonlyVEILState };
