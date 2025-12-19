import { Component } from '../component';
import {
  ConstraintFacet,
  PriorityConstraintFacet,
  BeforeComponentTypeConstraint,
  AfterComponentTypeConstraint,
  BeforeComponentIdConstraint,
  AfterComponentIdConstraint
} from '../constraints';

/**
 * Edge in the constraint graph representing an ordering requirement.
 * An edge from A to B means A must execute before B.
 */
export interface ConstraintEdge {
  from: string;           // Component ID that must come first
  to: string;             // Component ID that must come after
  constraint: ConstraintFacet;  // The constraint that created this edge
  reason: string;         // Human-readable explanation
}

/**
 * Node in the constraint graph representing a component
 */
export interface ConstraintNode {
  component: Component;
  id: string;
  type: string;           // Class name
  priority: number;       // Extracted from priority constraint (default 0)
  registrationIndex: number;  // For stable tiebreaking
  incomingEdges: ConstraintEdge[];
  outgoingEdges: ConstraintEdge[];
}

/**
 * Types of conflicts that can occur in constraint resolution
 */
export type ConflictType = 'cycle' | 'impossible' | 'self-contradictory' | 'missing-target';

/**
 * A conflict detected during constraint graph construction
 */
export interface ConstraintConflict {
  type: ConflictType;
  components: string[];       // Component IDs involved
  constraints: ConstraintFacet[];
  description: string;
}

/**
 * Result of building a constraint graph
 */
export interface ConstraintGraphResult {
  nodes: Map<string, ConstraintNode>;
  edges: ConstraintEdge[];
  conflicts: ConstraintConflict[];
  warnings: string[];
}

/**
 * Builds a directed graph from component constraints.
 *
 * The graph represents ordering requirements:
 * - An edge from A -> B means A must execute before B
 * - Priority constraints don't create edges (used as tiebreaker)
 * - Type constraints create edges to all matching components
 * - ID constraints create edges to specific components
 */
export class ConstraintGraphBuilder {
  private nodes = new Map<string, ConstraintNode>();
  private edges: ConstraintEdge[] = [];
  private conflicts: ConstraintConflict[] = [];
  private warnings: string[] = [];

  /**
   * Build constraint graph from components
   */
  build(components: Component[]): ConstraintGraphResult {
    this.reset();

    // Phase 1: Create nodes for all components
    this.createNodes(components);

    // Phase 2: Process constraints to create edges
    this.processAllConstraints();

    // Phase 3: Detect self-contradictory constraints within single component
    this.detectSelfContradictions();

    return {
      nodes: this.nodes,
      edges: this.edges,
      conflicts: this.conflicts,
      warnings: this.warnings
    };
  }

  private reset(): void {
    this.nodes.clear();
    this.edges = [];
    this.conflicts = [];
    this.warnings = [];
  }

  private createNodes(components: Component[]): void {
    components.forEach((component, index) => {
      const node: ConstraintNode = {
        component,
        id: component.id,
        type: component.constructor.name,
        priority: this.extractPriority(component),
        registrationIndex: index,
        incomingEdges: [],
        outgoingEdges: []
      };
      this.nodes.set(component.id, node);
    });
  }

  private extractPriority(component: Component): number {
    const priorityConstraint = component.constraints.find(
      c => c.type === 'priority'
    ) as PriorityConstraintFacet | undefined;
    return priorityConstraint?.priority ?? 0;
  }

  private processAllConstraints(): void {
    for (const [_id, node] of this.nodes) {
      for (const constraint of node.component.constraints) {
        this.processConstraint(node, constraint);
      }
    }
  }

  private processConstraint(node: ConstraintNode, constraint: ConstraintFacet): void {
    switch (constraint.type) {
      case 'priority':
        // Priority doesn't create edges - used as tiebreaker during sort
        break;

      case 'before-component-type':
        this.processBeforeType(node, constraint as BeforeComponentTypeConstraint);
        break;

      case 'after-component-type':
        this.processAfterType(node, constraint as AfterComponentTypeConstraint);
        break;

      case 'before-component-id':
        this.processBeforeId(node, constraint as BeforeComponentIdConstraint);
        break;

      case 'after-component-id':
        this.processAfterId(node, constraint as AfterComponentIdConstraint);
        break;

      default:
        this.warnings.push(
          `Unknown constraint type '${constraint.type}' on component '${node.id}'`
        );
    }
  }

  private processBeforeType(node: ConstraintNode, constraint: BeforeComponentTypeConstraint): void {
    const targetType = constraint.targetType;
    const matchingNodes = Array.from(this.nodes.values()).filter(
      n => n.type === targetType && n.id !== node.id
    );

    if (matchingNodes.length === 0) {
      this.warnings.push(
        `Component '${node.id}' has beforeComponentType('${targetType}'), ` +
        `but no other components of that type are registered`
      );
      return;
    }

    // Create edge: this node -> each matching node (this runs before them)
    for (const target of matchingNodes) {
      this.addEdge(
        node.id,
        target.id,
        constraint,
        `${node.id} must run before ${target.id} (type: ${targetType})`
      );
    }
  }

  private processAfterType(node: ConstraintNode, constraint: AfterComponentTypeConstraint): void {
    const targetType = constraint.targetType;
    const matchingNodes = Array.from(this.nodes.values()).filter(
      n => n.type === targetType && n.id !== node.id
    );

    if (matchingNodes.length === 0) {
      this.warnings.push(
        `Component '${node.id}' has afterComponentType('${targetType}'), ` +
        `but no other components of that type are registered`
      );
      return;
    }

    // Create edge: each matching node -> this node (they run before this)
    for (const target of matchingNodes) {
      this.addEdge(
        target.id,
        node.id,
        constraint,
        `${node.id} must run after ${target.id} (type: ${targetType})`
      );
    }
  }

  private processBeforeId(node: ConstraintNode, constraint: BeforeComponentIdConstraint): void {
    const targetId = constraint.targetId;

    if (targetId === node.id) {
      this.conflicts.push({
        type: 'self-contradictory',
        components: [node.id],
        constraints: [constraint],
        description: `Component '${node.id}' has beforeComponentId referencing itself`
      });
      return;
    }

    const target = this.nodes.get(targetId);
    if (!target) {
      this.conflicts.push({
        type: 'missing-target',
        components: [node.id],
        constraints: [constraint],
        description: `Component '${node.id}' has beforeComponentId('${targetId}'), but target not found`
      });
      return;
    }

    // Create edge: this node -> target (this runs before target)
    this.addEdge(
      node.id,
      targetId,
      constraint,
      `${node.id} must run before ${targetId}`
    );
  }

  private processAfterId(node: ConstraintNode, constraint: AfterComponentIdConstraint): void {
    const targetId = constraint.targetId;

    if (targetId === node.id) {
      this.conflicts.push({
        type: 'self-contradictory',
        components: [node.id],
        constraints: [constraint],
        description: `Component '${node.id}' has afterComponentId referencing itself`
      });
      return;
    }

    const target = this.nodes.get(targetId);
    if (!target) {
      this.conflicts.push({
        type: 'missing-target',
        components: [node.id],
        constraints: [constraint],
        description: `Component '${node.id}' has afterComponentId('${targetId}'), but target not found`
      });
      return;
    }

    // Create edge: target -> this node (target runs before this)
    this.addEdge(
      targetId,
      node.id,
      constraint,
      `${node.id} must run after ${targetId}`
    );
  }

  private addEdge(fromId: string, toId: string, constraint: ConstraintFacet, reason: string): void {
    const edge: ConstraintEdge = { from: fromId, to: toId, constraint, reason };
    this.edges.push(edge);

    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);

    if (fromNode) {
      fromNode.outgoingEdges.push(edge);
    }
    if (toNode) {
      toNode.incomingEdges.push(edge);
    }
  }

  /**
   * Detect cases where a single component has contradictory constraints
   * e.g., beforeComponentId('X') and afterComponentId('X')
   */
  private detectSelfContradictions(): void {
    for (const [_id, node] of this.nodes) {
      const beforeIds = new Set<string>();
      const afterIds = new Set<string>();
      const beforeTypes = new Set<string>();
      const afterTypes = new Set<string>();

      for (const constraint of node.component.constraints) {
        switch (constraint.type) {
          case 'before-component-id':
            beforeIds.add((constraint as BeforeComponentIdConstraint).targetId);
            break;
          case 'after-component-id':
            afterIds.add((constraint as AfterComponentIdConstraint).targetId);
            break;
          case 'before-component-type':
            beforeTypes.add((constraint as BeforeComponentTypeConstraint).targetType);
            break;
          case 'after-component-type':
            afterTypes.add((constraint as AfterComponentTypeConstraint).targetType);
            break;
        }
      }

      // Check for ID contradictions (before X and after X)
      for (const id of beforeIds) {
        if (afterIds.has(id)) {
          this.conflicts.push({
            type: 'self-contradictory',
            components: [node.id, id],
            constraints: node.component.constraints.filter(c =>
              (c.type === 'before-component-id' && (c as BeforeComponentIdConstraint).targetId === id) ||
              (c.type === 'after-component-id' && (c as AfterComponentIdConstraint).targetId === id)
            ),
            description: `Component '${node.id}' has both beforeComponentId('${id}') and afterComponentId('${id}')`
          });
        }
      }

      // Check for type contradictions (before Type and after Type)
      for (const type of beforeTypes) {
        if (afterTypes.has(type)) {
          this.conflicts.push({
            type: 'self-contradictory',
            components: [node.id],
            constraints: node.component.constraints.filter(c =>
              (c.type === 'before-component-type' && (c as BeforeComponentTypeConstraint).targetType === type) ||
              (c.type === 'after-component-type' && (c as AfterComponentTypeConstraint).targetType === type)
            ),
            description: `Component '${node.id}' has both beforeComponentType('${type}') and afterComponentType('${type}')`
          });
        }
      }
    }
  }
}
