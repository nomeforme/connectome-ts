/**
 * Global debug registry for runtime introspection via Node inspector
 * Only enabled when Node.js is launched with --inspect flag
 */

import { ConnectomeHost } from '../host/host';
import { Space } from '../spaces/space';
import { VEILStateManager } from '../veil/veil-state';
import { DebugServer } from './debug-server';
import { BasicAgent } from '../agent/basic-agent';
import { ComponentConstraintFacet, PriorityConstraintFacet } from '../spaces/constraints';
import * as inspector from 'inspector';

/**
 * Helper to extract priority value from a component's constraints (for grouping/ordering)
 */
function extractPriorityValue(component: { getConstraintFacets(): ComponentConstraintFacet[] }): number {
  const priorityFacet = component.getConstraintFacets().find(c => c.type === 'priority') as PriorityConstraintFacet | undefined;
  return priorityFacet?.priority ?? 0;
}

interface ComponentInfo {
  id: string;
  name: string;
  constraints: ComponentConstraintFacet[];
  enabled: boolean;
  type?: string;  // Constructor name
}

interface DebugRegistry {
  host?: ConnectomeHost;
  space?: Space;
  veilState?: VEILStateManager;
  debugServer?: DebugServer;
  agents?: Map<string, BasicAgent>;

  // Helper methods
  getComponents?: () => ComponentInfo[];
  getComponentsByPriority?: () => Map<number, ComponentInfo[]>;
}

const registry: DebugRegistry = {};

/**
 * Check if Node.js inspector is active
 */
function isInspectorActive(): boolean {
  // Method 1: Check if inspector URL is available
  const inspectorUrl = inspector.url();
  if (inspectorUrl !== undefined) {
    return true;
  }

  // Method 2: Check process.execArgv for --inspect flags
  const hasInspectFlag = process.execArgv.some(arg =>
    arg.includes('--inspect') || arg.includes('--inspect-brk')
  );

  return hasInspectFlag;
}

/**
 * Initialize the debug registry if inspector is active
 */
function initRegistry(): void {
  if (!isInspectorActive()) {
    return;
  }

  (global as any).__connectome_debug = registry;
  console.log('🔍 Inspector detected - Debug registry enabled');
  console.log('   Access via: global.__connectome_debug');
  console.log(`   Inspector URL: ${inspector.url()}`);
}

export function registerDebugHost(host: ConnectomeHost): void {
  if (!isInspectorActive()) {
    return;
  }

  initRegistry();
  registry.host = host;
  console.log('   ✓ Host registered');
}

export function registerDebugSpace(space: Space): void {
  if (!isInspectorActive()) {
    return;
  }

  initRegistry();
  registry.space = space;
  registry.veilState = space.getVEILStateManager();

  // Add helper methods for component inspection
  registry.getComponents = (): ComponentInfo[] => {
    if (!registry.space) return [];
    return registry.space.components.map(c => ({
      id: c.id,
      name: c.constructor.name,
      constraints: c.getConstraintFacets(),
      enabled: c.enabled,
      type: c.constructor.name
    }));
  };

  registry.getComponentsByPriority = (): Map<number, ComponentInfo[]> => {
    const byPriority = new Map<number, ComponentInfo[]>();
    if (!registry.space) return byPriority;

    for (const c of registry.space.components) {
      const priorityValue = extractPriorityValue(c);
      const info: ComponentInfo = {
        id: c.id,
        name: c.constructor.name,
        constraints: c.getConstraintFacets(),
        enabled: c.enabled,
        type: c.constructor.name
      };

      if (!byPriority.has(priorityValue)) {
        byPriority.set(priorityValue, []);
      }
      byPriority.get(priorityValue)!.push(info);
    }

    return byPriority;
  };

  console.log('   ✓ Space and VEILState registered');
  console.log(`   ✓ Component inspection helpers added (${space.components.length} components)`);
}

export function registerDebugServer(debugServer: DebugServer): void {
  if (!isInspectorActive()) {
    return;
  }

  initRegistry();
  registry.debugServer = debugServer;
  console.log('   ✓ DebugServer registered');
}

export function registerDebugAgent(agentId: string, agent: BasicAgent): void {
  if (!isInspectorActive()) {
    return;
  }

  initRegistry();
  if (!registry.agents) {
    registry.agents = new Map();
  }
  registry.agents.set(agentId, agent);
}

export function getDebugRegistry(): Readonly<DebugRegistry> {
  return registry;
}

/**
 * Check if debug registry is active
 */
export function isDebugRegistryActive(): boolean {
  return isInspectorActive();
}
