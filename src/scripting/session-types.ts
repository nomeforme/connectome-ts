/**
 * Lua Session Types
 *
 * Types for persistent Lua REPL sessions that maintain state across
 * multiple script executions.
 */

import type { BaseFacet } from '../veil/facet-types';
import type { LuaSandbox } from './lua-sandbox';

// ============================================
// SESSION CONFIGURATION
// ============================================

/**
 * Configuration for session timeouts
 */
export interface SessionTimeoutConfig {
  /** Close session after N ms of inactivity (default: 300000 = 5min) */
  idleTimeoutMs: number;

  /** Absolute max lifetime in ms (default: 3600000 = 1hr) */
  maxLifetimeMs: number;

  /** Emit warning facet N ms before timeout (default: 30000 = 30s) */
  warningBeforeMs: number;
}

/**
 * Default timeout configuration
 */
export const DEFAULT_SESSION_TIMEOUT_CONFIG: SessionTimeoutConfig = {
  idleTimeoutMs: 300000,      // 5 minutes
  maxLifetimeMs: 3600000,     // 1 hour
  warningBeforeMs: 30000,     // 30 seconds warning
};

// ============================================
// SESSION STATE
// ============================================

/**
 * Runtime state for an active Lua session
 */
export interface LuaSession {
  /** Session name (user-provided) */
  id: string;

  /** Active Lua environment */
  sandbox: LuaSandbox;

  /** Optional initialization code (runs on restore) */
  initScript?: string;

  /** When session was created */
  createdAt: Date;

  /** Last activity timestamp (for idle timeout) */
  lastActivityAt: Date;

  /** Script IDs currently running in this session */
  pendingScripts: Set<string>;

  /** Session lifecycle status */
  status: 'active' | 'closing' | 'closed';
}

/**
 * Serialized session state for persistence
 */
export interface SerializedSessionState {
  /** Session name */
  id: string;

  /** JSON-serialized Lua globals */
  globals: Record<string, unknown>;

  /** Init code to run on restore */
  initScript?: string;

  /** ISO date string */
  createdAt: string;

  /** ISO date string */
  lastActivityAt: string;
}

/**
 * Session metadata for listing
 */
export interface SessionMetadata {
  /** Session name */
  id: string;

  /** When session was created */
  createdAt: Date;

  /** Last activity timestamp */
  lastActivityAt: Date;

  /** Number of currently running scripts */
  pendingScriptCount: number;

  /** Session status */
  status: 'active' | 'closing' | 'closed';
}

// ============================================
// SESSION FACETS
// ============================================

/**
 * Emitted when a session is opened
 */
export type SessionOpenedFacet = BaseFacet & {
  type: 'session-opened';

  /** Session name */
  sessionId: string;

  /** Whether session was newly created vs already existed */
  created: boolean;

  /** Whether an initScript was run */
  hadInitScript: boolean;
};

/**
 * Emitted when a session is closed
 */
export type SessionClosedFacet = BaseFacet & {
  type: 'session-closed';

  /** Session name */
  sessionId: string;

  /** Why the session was closed */
  reason: 'explicit' | 'timeout' | 'error' | 'shutdown';

  /** Scripts that were interrupted (if any) */
  interruptedScripts?: string[];
};

/**
 * Emitted when a session is restored from persistence
 */
export type SessionRestoredFacet = BaseFacet & {
  type: 'session-restored';

  /** Session name */
  sessionId: string;

  /** Scripts that were interrupted during restore */
  interruptedScripts?: string[];

  /** Whether initScript was re-run */
  ranInitScript: boolean;

  /** Globals that were restored */
  restoredGlobalCount: number;
};

/**
 * Emitted as warning before session timeout
 */
export type SessionTimeoutWarningFacet = BaseFacet & {
  type: 'session-timeout-warning';

  /** Session name */
  sessionId: string;

  /** Seconds until session closes */
  secondsRemaining: number;
};

/**
 * Union of all session facet types
 */
export type SessionFacet =
  | SessionOpenedFacet
  | SessionClosedFacet
  | SessionRestoredFacet
  | SessionTimeoutWarningFacet;

// ============================================
// TYPE GUARDS
// ============================================

export function isSessionOpenedFacet(facet: BaseFacet): facet is SessionOpenedFacet {
  return facet.type === 'session-opened';
}

export function isSessionClosedFacet(facet: BaseFacet): facet is SessionClosedFacet {
  return facet.type === 'session-closed';
}

export function isSessionRestoredFacet(facet: BaseFacet): facet is SessionRestoredFacet {
  return facet.type === 'session-restored';
}

export function isSessionTimeoutWarningFacet(facet: BaseFacet): facet is SessionTimeoutWarningFacet {
  return facet.type === 'session-timeout-warning';
}

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Create a session-opened facet
 */
export function createSessionOpenedFacet(
  id: string,
  sessionId: string,
  created: boolean,
  hadInitScript: boolean
): SessionOpenedFacet {
  return {
    id,
    type: 'session-opened',
    sessionId,
    created,
    hadInitScript,
  };
}

/**
 * Create a session-closed facet
 */
export function createSessionClosedFacet(
  id: string,
  sessionId: string,
  reason: SessionClosedFacet['reason'],
  interruptedScripts?: string[]
): SessionClosedFacet {
  const facet: SessionClosedFacet = {
    id,
    type: 'session-closed',
    sessionId,
    reason,
  };
  if (interruptedScripts && interruptedScripts.length > 0) {
    facet.interruptedScripts = interruptedScripts;
  }
  return facet;
}

/**
 * Create a session-restored facet
 */
export function createSessionRestoredFacet(
  id: string,
  sessionId: string,
  ranInitScript: boolean,
  restoredGlobalCount: number,
  interruptedScripts?: string[]
): SessionRestoredFacet {
  const facet: SessionRestoredFacet = {
    id,
    type: 'session-restored',
    sessionId,
    ranInitScript,
    restoredGlobalCount,
  };
  if (interruptedScripts && interruptedScripts.length > 0) {
    facet.interruptedScripts = interruptedScripts;
  }
  return facet;
}

/**
 * Create a session-timeout-warning facet
 */
export function createSessionTimeoutWarningFacet(
  id: string,
  sessionId: string,
  secondsRemaining: number
): SessionTimeoutWarningFacet {
  return {
    id,
    type: 'session-timeout-warning',
    sessionId,
    secondsRemaining,
  };
}

// ============================================
// SERIALIZATION HELPERS
// ============================================

/**
 * Marker for circular references in serialized state
 */
export interface CircularRefMarker {
  __circular_ref: true;
  path: string;
}

/**
 * Marker for truncated values in serialized state
 */
export interface TruncatedMarker {
  __truncated: true;
  originalType: string;
  reason: string;
}

/**
 * Check if a value is a circular reference marker
 */
export function isCircularRefMarker(value: unknown): value is CircularRefMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as any).__circular_ref === true
  );
}

/**
 * Check if a value is a truncated marker
 */
export function isTruncatedMarker(value: unknown): value is TruncatedMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as any).__truncated === true
  );
}
