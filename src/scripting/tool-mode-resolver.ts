/**
 * ToolModeResolver - Resolves effective invocation mode for tools
 *
 * This component maintains awareness of tool mode preferences in VEIL state
 * and provides a resolution API that other components can use to determine
 * whether a tool should be executed in 'native' or 'programmatic' mode.
 *
 * Resolution priority (highest to lowest):
 * 1. Explicit preference facets with highest priority value
 * 2. Tool-specific preference facets
 * 3. Wildcard (*) preference facets
 * 4. Tool's default mode from definition
 * 5. System default ('native')
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { ReadonlyVEILState } from '../spaces/component-types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import {
  ToolInvocationMode,
  ToolModePreferenceFacet,
  isToolModePreferenceFacet,
  ScriptableTool,
  IToolRegistry,
} from './types';
import { getGlobalToolRegistry } from './tool-registry';

/**
 * Result of resolving a tool's invocation mode
 */
export interface ToolModeResolution {
  /** The resolved mode */
  mode: ToolInvocationMode;
  
  /** Where the mode came from */
  source: 'preference-facet' | 'tool-default' | 'system-default';
  
  /** If from facet, the facet ID */
  facetId?: string;
  
  /** If from facet, who set it */
  setBy?: string;
}

/**
 * ToolModeResolver component
 *
 * Provides resolution of tool invocation modes based on:
 * - ToolModePreferenceFacet instances in VEIL state
 * - Tool definitions (defaultInvocationMode)
 * - System defaults
 */
export class ToolModeResolver extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];

  private toolRegistry?: IToolRegistry;

  /**
   * Set the tool registry for looking up tool defaults
   */
  setToolRegistry(registry: IToolRegistry): void {
    this.toolRegistry = registry;
  }

  onMount(): void {
    // Try to get tool registry from space references, fall back to global
    if (!this.toolRegistry) {
      this.toolRegistry = this.getReference<IToolRegistry>('toolRegistry');
      if (!this.toolRegistry) {
        this.toolRegistry = getGlobalToolRegistry();
      }
    }
  }

  /**
   * FLEX execute - no active work, just maintains readiness
   */
  execute(context: ExecutionContext): void {
    // This component is primarily a query service
    // No active work needed per frame
  }

  /**
   * Resolve the effective invocation mode for a tool
   *
   * @param toolName Name of the tool to resolve mode for
   * @param state Current VEIL state to search for preferences
   * @param agentId Optional agent ID to filter agent-specific preferences
   * @returns Resolution result with mode and source information
   */
  resolveMode(
    toolName: string,
    state: ReadonlyVEILState,
    agentId?: string
  ): ToolModeResolution {
    const now = Date.now();

    // 1. Collect all relevant preference facets
    const preferences: ToolModePreferenceFacet[] = [];
    
    for (const facet of state.facets.values()) {
      if (!isToolModePreferenceFacet(facet)) continue;

      // Skip expired preferences
      if (facet.expiresAt && facet.expiresAt < now) continue;

      // Skip agent-specific preferences that don't match
      if (facet.targetAgentId && agentId && facet.targetAgentId !== agentId) continue;

      // Include if matches this tool or is wildcard
      if (facet.toolName === toolName || facet.toolName === '*') {
        preferences.push(facet);
      }
    }

    // 2. Sort by priority (higher first), then prefer specific over wildcard
    preferences.sort((a, b) => {
      const priorityA = a.priority ?? 50;
      const priorityB = b.priority ?? 50;
      
      if (priorityA !== priorityB) {
        return priorityB - priorityA; // Higher priority first
      }
      
      // Prefer specific tool name over wildcard
      if (a.toolName === toolName && b.toolName === '*') return -1;
      if (a.toolName === '*' && b.toolName === toolName) return 1;
      
      return 0;
    });

    // 3. If we have a preference, use it
    if (preferences.length > 0) {
      const pref = preferences[0];
      return {
        mode: pref.preferredMode,
        source: 'preference-facet',
        facetId: pref.id,
        setBy: pref.setBy,
      };
    }

    // 4. Check tool's default mode from registry
    const tool = this.toolRegistry?.getTool(toolName);
    if (tool?.defaultInvocationMode) {
      return {
        mode: tool.defaultInvocationMode,
        source: 'tool-default',
      };
    }

    // 5. System default
    return {
      mode: 'native',
      source: 'system-default',
    };
  }

  /**
   * Get all current mode preferences from VEIL state
   */
  getAllPreferences(state: ReadonlyVEILState): ToolModePreferenceFacet[] {
    const now = Date.now();
    const preferences: ToolModePreferenceFacet[] = [];

    for (const facet of state.facets.values()) {
      if (!isToolModePreferenceFacet(facet)) continue;
      
      // Skip expired
      if (facet.expiresAt && facet.expiresAt < now) continue;
      
      preferences.push(facet);
    }

    return preferences;
  }

  /**
   * Check if a tool allows mode override
   */
  canOverrideMode(toolName: string): boolean {
    const tool = this.toolRegistry?.getTool(toolName);
    // Default to true if not specified
    return tool?.allowModeOverride !== false;
  }
}

/**
 * Create a new ToolModeResolver instance
 */
export function createToolModeResolver(): ToolModeResolver {
  return new ToolModeResolver();
}

// ============================================
// STANDALONE RESOLUTION FUNCTION
// ============================================

/**
 * Standalone function to resolve tool mode without needing a component instance.
 * Useful for one-off resolution in other components.
 *
 * @param toolName Name of the tool
 * @param state VEIL state
 * @param toolRegistry Optional tool registry for default lookups
 * @param agentId Optional agent ID for agent-specific preferences
 */
export function resolveToolMode(
  toolName: string,
  state: ReadonlyVEILState,
  toolRegistry?: IToolRegistry,
  agentId?: string
): ToolModeResolution {
  const now = Date.now();

  // 1. Collect preferences
  const preferences: ToolModePreferenceFacet[] = [];
  
  for (const facet of state.facets.values()) {
    if (!isToolModePreferenceFacet(facet)) continue;
    if (facet.expiresAt && facet.expiresAt < now) continue;
    if (facet.targetAgentId && agentId && facet.targetAgentId !== agentId) continue;
    if (facet.toolName === toolName || facet.toolName === '*') {
      preferences.push(facet);
    }
  }

  // 2. Sort by priority, then by specificity, then by recency (most recent wins)
  preferences.sort((a, b) => {
    const priorityA = a.priority ?? 50;
    const priorityB = b.priority ?? 50;
    if (priorityA !== priorityB) return priorityB - priorityA;
    // Prefer tool-specific over wildcard
    if (a.toolName === toolName && b.toolName === '*') return -1;
    if (a.toolName === '*' && b.toolName === toolName) return 1;
    // When all else is equal, prefer most recent (facet ID contains timestamp)
    // IDs are like "tool-mode:discord_send:1768228280055" - compare the timestamp suffix
    return b.id.localeCompare(a.id);
  });

  // 3. Return from preference
  if (preferences.length > 0) {
    const pref = preferences[0];
    return {
      mode: pref.preferredMode,
      source: 'preference-facet',
      facetId: pref.id,
      setBy: pref.setBy,
    };
  }

  // 4. Check tool default
  const registry = toolRegistry || getGlobalToolRegistry();
  const tool = registry?.getTool(toolName);
  if (tool?.defaultInvocationMode) {
    return {
      mode: tool.defaultInvocationMode,
      source: 'tool-default',
    };
  }

  // 5. System default
  return {
    mode: 'native',
    source: 'system-default',
  };
}
