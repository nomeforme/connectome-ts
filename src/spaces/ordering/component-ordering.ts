import { Component } from '../component';
import { PriorityConstraintFacet } from '../constraints';
import { ConstraintGraphBuilder, ConstraintGraphResult } from './constraint-graph';
import { TopologicalSorter, TopologicalSortResult } from './topological-sort';

export interface ComponentOrderingStrategy {
  order(components: Component[]): Component[];
}

/**
 * Result details from multi-constraint ordering (for debugging/diagnostics)
 */
export interface MultiConstraintOrderingResult {
  graphResult: ConstraintGraphResult;
  sortResult: TopologicalSortResult;
}

export class PriorityOrderingStrategy implements ComponentOrderingStrategy {
  order(components: Component[]): Component[] {
    return components
      .map((component, index) => ({
        component,
        priority: this.getPriority(component),
        registrationOrder: index
      }))
      .sort((a, b) => {
        if (a.priority === b.priority) {
          return a.registrationOrder - b.registrationOrder;
        }
        return a.priority - b.priority;
      })
      .map(entry => entry.component);
  }

  private getPriority(component: Component): number {
    const priorityFacet = component
      .getConstraintFacets()
      .find(facet => facet.type === 'priority') as PriorityConstraintFacet | undefined;

    return priorityFacet?.priority ?? 0;
  }
}

export interface MultiConstraintOrderingOptions {
  /** Log warnings to console (default: false) */
  verbose?: boolean;
  /** Callback for detailed ordering results */
  onOrderingComplete?: (result: MultiConstraintOrderingResult) => void;
}

/**
 * Advanced ordering strategy that respects all constraint types
 * with best-effort conflict resolution.
 *
 * Supports:
 * - Priority constraints (tiebreaker)
 * - Before/After component type constraints
 * - Before/After component ID constraints
 *
 * When constraints conflict:
 * - Cycles are detected and broken by dropping least-specific edges
 * - Self-contradictory constraints are detected and dropped
 * - Missing targets generate warnings
 * - Priority is used as tiebreaker within topological layers
 * - Registration order is the final tiebreaker
 */
export class MultiConstraintOrderingStrategy implements ComponentOrderingStrategy {
  private verbose: boolean;
  private onOrderingComplete?: (result: MultiConstraintOrderingResult) => void;
  private lastResult?: MultiConstraintOrderingResult;

  constructor(options: MultiConstraintOrderingOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.onOrderingComplete = options.onOrderingComplete;
  }

  order(components: Component[]): Component[] {
    if (components.length === 0) return [];

    // Phase 1: Build constraint graph
    const graphBuilder = new ConstraintGraphBuilder();
    const graphResult = graphBuilder.build(components);

    // Phase 2: Topological sort with conflict resolution
    const sorter = new TopologicalSorter(graphResult);
    const sortResult = sorter.sort();

    // Store result for diagnostics
    this.lastResult = { graphResult, sortResult };

    // Emit callback if provided
    if (this.onOrderingComplete) {
      this.onOrderingComplete(this.lastResult);
    }

    // Log diagnostics if verbose
    if (this.verbose) {
      this.logDiagnostics(graphResult, sortResult);
    }

    return sortResult.ordered;
  }

  /**
   * Get the last ordering result for diagnostics
   */
  getLastResult(): MultiConstraintOrderingResult | undefined {
    return this.lastResult;
  }

  private logDiagnostics(graphResult: ConstraintGraphResult, sortResult: TopologicalSortResult): void {
    const allWarnings = [...graphResult.warnings, ...sortResult.warnings];

    if (allWarnings.length > 0) {
      console.warn('[MultiConstraintOrdering] Warnings:');
      for (const warning of allWarnings) {
        console.warn(`  - ${warning}`);
      }
    }

    if (graphResult.conflicts.length > 0) {
      console.warn('[MultiConstraintOrdering] Conflicts detected:');
      for (const conflict of graphResult.conflicts) {
        console.warn(`  - [${conflict.type}] ${conflict.description}`);
      }
    }

    if (sortResult.droppedEdges.length > 0) {
      console.warn('[MultiConstraintOrdering] Dropped constraints:');
      for (const edge of sortResult.droppedEdges) {
        console.warn(`  - ${edge.reason}`);
      }
    }

    if (sortResult.resolvedCycles.length > 0) {
      console.warn('[MultiConstraintOrdering] Resolved cycles:');
      for (const cycle of sortResult.resolvedCycles) {
        console.warn(`  - ${cycle.join(' -> ')}`);
      }
    }

    // Log final order
    console.log('[MultiConstraintOrdering] Final order:');
    console.log(`  ${sortResult.ordered.map(c => `${c.constructor.name}(${c.id})`).join(' -> ')}`);
  }
}


