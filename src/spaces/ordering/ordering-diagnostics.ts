import { ConstraintGraphResult, ConstraintConflict, ConstraintEdge } from './constraint-graph';
import { TopologicalSortResult } from './topological-sort';
import { MultiConstraintOrderingResult } from './component-ordering';

/**
 * Summary statistics for ordering diagnostics
 */
export interface OrderingSummary {
  totalComponents: number;
  totalEdges: number;
  conflictsDetected: number;
  cyclesResolved: number;
  constraintsDropped: number;
  warningCount: number;
  hasIssues: boolean;
}

/**
 * Formatter for constraint ordering diagnostics.
 *
 * Provides human-readable output for debugging constraint issues.
 */
export class OrderingDiagnosticsFormatter {
  /**
   * Format the full diagnostics report
   */
  format(result: MultiConstraintOrderingResult): string {
    const lines: string[] = [];
    const { graphResult, sortResult } = result;

    lines.push('╔══════════════════════════════════════════════════════════════╗');
    lines.push('║            CONSTRAINT ORDERING DIAGNOSTICS                   ║');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('');

    // Summary
    const summary = this.getSummary(result);
    lines.push(`Components: ${summary.totalComponents}`);
    lines.push(`Constraint Edges: ${summary.totalEdges}`);
    lines.push(`Status: ${summary.hasIssues ? '⚠️  Issues detected' : '✓ No issues'}`);
    lines.push('');

    // Conflicts
    if (graphResult.conflicts.length > 0) {
      lines.push('─── CONFLICTS ───────────────────────────────────────────────');
      for (const conflict of graphResult.conflicts) {
        lines.push(this.formatConflict(conflict));
      }
      lines.push('');
    }

    // Cycles
    if (sortResult.resolvedCycles.length > 0) {
      lines.push('─── RESOLVED CYCLES ─────────────────────────────────────────');
      for (const cycle of sortResult.resolvedCycles) {
        lines.push(`  ↻ ${cycle.join(' → ')}`);
      }
      lines.push('');
    }

    // Dropped constraints
    if (sortResult.droppedEdges.length > 0) {
      lines.push('─── DROPPED CONSTRAINTS ─────────────────────────────────────');
      for (const edge of sortResult.droppedEdges) {
        lines.push(this.formatDroppedEdge(edge));
      }
      lines.push('');
    }

    // Warnings
    const allWarnings = [...graphResult.warnings, ...sortResult.warnings];
    if (allWarnings.length > 0) {
      lines.push('─── WARNINGS ────────────────────────────────────────────────');
      for (const warning of allWarnings) {
        lines.push(`  ⚠ ${warning}`);
      }
      lines.push('');
    }

    // Final order
    lines.push('─── FINAL EXECUTION ORDER ───────────────────────────────────');
    sortResult.ordered.forEach((component, index) => {
      const node = graphResult.nodes.get(component.id);
      const priority = node?.priority ?? 0;
      lines.push(`  ${index + 1}. ${component.constructor.name} (id: ${component.id}, priority: ${priority})`);
    });
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Get summary statistics
   */
  getSummary(result: MultiConstraintOrderingResult): OrderingSummary {
    const { graphResult, sortResult } = result;
    const allWarnings = [...graphResult.warnings, ...sortResult.warnings];

    return {
      totalComponents: graphResult.nodes.size,
      totalEdges: graphResult.edges.length,
      conflictsDetected: graphResult.conflicts.length,
      cyclesResolved: sortResult.resolvedCycles.length,
      constraintsDropped: sortResult.droppedEdges.length,
      warningCount: allWarnings.length,
      hasIssues: graphResult.conflicts.length > 0 ||
                 sortResult.resolvedCycles.length > 0 ||
                 sortResult.droppedEdges.length > 0 ||
                 allWarnings.length > 0
    };
  }

  /**
   * Get a one-line summary string
   */
  getOneLiner(result: MultiConstraintOrderingResult): string {
    const summary = this.getSummary(result);

    if (!summary.hasIssues) {
      return `Ordering: ${summary.totalComponents} components, ${summary.totalEdges} edges, no issues`;
    }

    const issues: string[] = [];
    if (summary.conflictsDetected > 0) issues.push(`${summary.conflictsDetected} conflicts`);
    if (summary.cyclesResolved > 0) issues.push(`${summary.cyclesResolved} cycles`);
    if (summary.constraintsDropped > 0) issues.push(`${summary.constraintsDropped} dropped`);
    if (summary.warningCount > 0) issues.push(`${summary.warningCount} warnings`);

    return `Ordering: ${summary.totalComponents} components - ${issues.join(', ')}`;
  }

  private formatConflict(conflict: ConstraintConflict): string {
    const typeLabel = {
      'cycle': '↻ CYCLE',
      'impossible': '✗ IMPOSSIBLE',
      'self-contradictory': '⊘ SELF-CONTRADICTORY',
      'missing-target': '? MISSING TARGET'
    }[conflict.type] || conflict.type.toUpperCase();

    const lines = [
      `  [${typeLabel}]`,
      `    ${conflict.description}`,
      `    Components: ${conflict.components.join(', ')}`
    ];

    if (conflict.constraints.length > 0) {
      lines.push('    Constraints:');
      for (const c of conflict.constraints) {
        lines.push(`      - ${JSON.stringify(c)}`);
      }
    }

    return lines.join('\n');
  }

  private formatDroppedEdge(edge: ConstraintEdge): string {
    return [
      `  ✗ ${edge.from} → ${edge.to}`,
      `    Reason: ${edge.reason}`,
      `    Constraint: ${JSON.stringify(edge.constraint)}`
    ].join('\n');
  }
}

/**
 * Validate ordering result and return validation errors
 */
export function validateOrderingResult(result: MultiConstraintOrderingResult): string[] {
  const errors: string[] = [];
  const { graphResult, sortResult } = result;

  // Check all components are in the result
  const orderedIds = new Set(sortResult.ordered.map(c => c.id));
  for (const nodeId of graphResult.nodes.keys()) {
    if (!orderedIds.has(nodeId)) {
      errors.push(`Component '${nodeId}' missing from ordered result`);
    }
  }

  // Check for duplicate components
  if (orderedIds.size !== sortResult.ordered.length) {
    errors.push('Duplicate components in ordered result');
  }

  return errors;
}
