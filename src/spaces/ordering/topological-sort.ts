import { Component } from '../component';
import { ConstraintFacet } from '../constraints';
import { ConstraintNode, ConstraintEdge, ConstraintConflict, ConstraintGraphResult } from './constraint-graph';

/**
 * Result of topological sorting with conflict resolution
 */
export interface TopologicalSortResult {
  ordered: Component[];
  droppedEdges: ConstraintEdge[];
  resolvedCycles: string[][];  // Each cycle as list of component IDs
  warnings: string[];
}

/**
 * Topological sorter with best-effort conflict resolution.
 *
 * Algorithm:
 * 1. Detect cycles using DFS
 * 2. Break cycles by dropping edges (best-effort)
 * 3. Perform Kahn's algorithm for topological sort
 * 4. Use priority as tiebreaker within same topological layer
 * 5. Use registration order as final tiebreaker
 */
export class TopologicalSorter {
  private nodes: Map<string, ConstraintNode>;
  private edges: ConstraintEdge[];
  private conflicts: ConstraintConflict[];
  private droppedEdges: ConstraintEdge[] = [];
  private resolvedCycles: string[][] = [];
  private warnings: string[] = [];

  constructor(graphResult: ConstraintGraphResult) {
    // Deep clone nodes to avoid mutating the original
    this.nodes = new Map();
    for (const [id, node] of graphResult.nodes) {
      this.nodes.set(id, {
        ...node,
        incomingEdges: [...node.incomingEdges],
        outgoingEdges: [...node.outgoingEdges]
      });
    }
    this.edges = [...graphResult.edges];
    this.conflicts = [...graphResult.conflicts];
    this.warnings = [...graphResult.warnings];
  }

  /**
   * Perform topological sort with conflict resolution
   */
  sort(): TopologicalSortResult {
    // Phase 1: Handle pre-detected conflicts from graph building
    this.handlePreDetectedConflicts();

    // Phase 2: Detect and break cycles
    this.detectAndBreakCycles();

    // Phase 3: Perform Kahn's algorithm
    const ordered = this.kahnsAlgorithm();

    return {
      ordered,
      droppedEdges: this.droppedEdges,
      resolvedCycles: this.resolvedCycles,
      warnings: this.warnings
    };
  }

  private handlePreDetectedConflicts(): void {
    for (const conflict of this.conflicts) {
      switch (conflict.type) {
        case 'self-contradictory':
          // For self-contradictory constraints, drop all involved edges
          this.dropConflictingEdges(conflict);
          this.warnings.push(`Dropped self-contradictory constraints: ${conflict.description}`);
          break;

        case 'missing-target':
          // Missing targets don't create edges, just warn
          this.warnings.push(`Missing target: ${conflict.description}`);
          break;

        case 'impossible':
        case 'cycle':
          // Will be handled in cycle detection phase
          break;
      }
    }
  }

  private dropConflictingEdges(conflict: ConstraintConflict): void {
    // Find and drop edges created by the conflicting constraints
    for (const constraint of conflict.constraints) {
      const edgesToDrop = this.edges.filter(e => e.constraint === constraint);
      for (const edge of edgesToDrop) {
        this.dropEdge(edge);
      }
    }
  }

  /**
   * Detect cycles using DFS and break them by dropping edges
   */
  private detectAndBreakCycles(): void {
    let cycleFound = true;

    // Keep detecting and breaking cycles until none remain
    while (cycleFound) {
      cycleFound = false;
      const visited = new Set<string>();
      const recursionStack = new Set<string>();

      for (const nodeId of this.nodes.keys()) {
        if (!visited.has(nodeId)) {
          const cycle = this.dfsDetectCycle(nodeId, visited, recursionStack, []);
          if (cycle) {
            cycleFound = true;
            this.breakCycle(cycle);
            break; // Restart detection after breaking a cycle
          }
        }
      }
    }
  }

  private dfsDetectCycle(
    nodeId: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[]
  ): string[] | null {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const node = this.nodes.get(nodeId);
    if (!node) return null;

    for (const edge of node.outgoingEdges) {
      const neighborId = edge.to;

      if (!visited.has(neighborId)) {
        const cycle = this.dfsDetectCycle(neighborId, visited, recursionStack, path);
        if (cycle) return cycle;
      } else if (recursionStack.has(neighborId)) {
        // Found a cycle - extract it
        const cycleStart = path.indexOf(neighborId);
        const cycle = path.slice(cycleStart);
        cycle.push(neighborId); // Complete the cycle
        return cycle;
      }
    }

    recursionStack.delete(nodeId);
    path.pop();
    return null;
  }

  private breakCycle(cycle: string[]): void {
    this.resolvedCycles.push([...cycle]);

    // Find all edges in the cycle
    const cycleEdges: ConstraintEdge[] = [];
    for (let i = 0; i < cycle.length - 1; i++) {
      const fromId = cycle[i];
      const toId = cycle[i + 1];
      const edge = this.edges.find(e => e.from === fromId && e.to === toId);
      if (edge) {
        cycleEdges.push(edge);
      }
    }

    if (cycleEdges.length === 0) return;

    // Choose edge to drop based on constraint importance
    // Strategy: Keep ID constraints over type constraints (more specific wins)
    const edgeToDrop = this.selectEdgeToDrop(cycleEdges);

    this.dropEdge(edgeToDrop);
    this.warnings.push(
      `Broke cycle [${cycle.join(' -> ')}] by dropping: ${edgeToDrop.reason}`
    );
  }

  private selectEdgeToDrop(edges: ConstraintEdge[]): ConstraintEdge {
    // Score edges by importance (lower = less important = prefer to drop)
    const scored = edges.map(edge => ({
      edge,
      importance: this.getConstraintImportance(edge.constraint)
    }));

    // Sort by importance ascending (drop least important)
    scored.sort((a, b) => a.importance - b.importance);

    return scored[0].edge;
  }

  private getConstraintImportance(constraint: ConstraintFacet): number {
    // Higher number = more important (less likely to drop)
    switch (constraint.type) {
      case 'before-component-id':
      case 'after-component-id':
        return 2; // ID constraints are specific, try to keep

      case 'before-component-type':
      case 'after-component-type':
        return 1; // Type constraints are general, prefer to drop

      default:
        return 0;
    }
  }

  private dropEdge(edge: ConstraintEdge): void {
    // Remove from edges array
    const edgeIndex = this.edges.indexOf(edge);
    if (edgeIndex !== -1) {
      this.edges.splice(edgeIndex, 1);
    }

    // Remove from node's outgoing edges
    const fromNode = this.nodes.get(edge.from);
    if (fromNode) {
      const outIndex = fromNode.outgoingEdges.indexOf(edge);
      if (outIndex !== -1) {
        fromNode.outgoingEdges.splice(outIndex, 1);
      }
    }

    // Remove from node's incoming edges
    const toNode = this.nodes.get(edge.to);
    if (toNode) {
      const inIndex = toNode.incomingEdges.indexOf(edge);
      if (inIndex !== -1) {
        toNode.incomingEdges.splice(inIndex, 1);
      }
    }

    this.droppedEdges.push(edge);
  }

  /**
   * Kahn's algorithm with priority and registration order tiebreaking
   */
  private kahnsAlgorithm(): Component[] {
    const result: Component[] = [];

    // Calculate in-degree for each node
    const inDegree = new Map<string, number>();
    for (const [id, node] of this.nodes) {
      inDegree.set(id, node.incomingEdges.length);
    }

    // Queue of nodes with no remaining dependencies
    const queue: ConstraintNode[] = [];

    // Initialize queue with nodes having in-degree 0
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        const node = this.nodes.get(id);
        if (node) queue.push(node);
      }
    }

    // Sort queue by priority, then registration order
    this.sortQueue(queue);

    while (queue.length > 0) {
      // Take the highest-priority node (first in sorted queue)
      const node = queue.shift()!;
      result.push(node.component);

      // Reduce in-degree of neighbors and add to queue if ready
      for (const edge of node.outgoingEdges) {
        const neighborId = edge.to;
        const currentDegree = inDegree.get(neighborId)!;
        const newDegree = currentDegree - 1;
        inDegree.set(neighborId, newDegree);

        if (newDegree === 0) {
          const neighborNode = this.nodes.get(neighborId);
          if (neighborNode) {
            queue.push(neighborNode);
          }
        }
      }

      // Re-sort queue to maintain priority ordering
      this.sortQueue(queue);
    }

    // Check for unprocessed nodes (shouldn't happen after cycle resolution)
    if (result.length !== this.nodes.size) {
      const processed = new Set(result.map(c => c.id));
      const remaining = Array.from(this.nodes.values())
        .filter(n => !processed.has(n.id));

      this.warnings.push(
        `Topological sort incomplete: ${result.length}/${this.nodes.size} components. ` +
        `Remaining: ${remaining.map(n => n.id).join(', ')}`
      );

      // Add remaining in priority order as fallback
      this.sortQueue(remaining);
      for (const node of remaining) {
        result.push(node.component);
      }
    }

    return result;
  }

  private sortQueue(queue: ConstraintNode[]): void {
    queue.sort((a, b) => {
      // 1. Sort by priority (lower = earlier)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      // 2. Sort by registration order (earlier registered = earlier execution)
      return a.registrationIndex - b.registrationIndex;
    });
  }
}
