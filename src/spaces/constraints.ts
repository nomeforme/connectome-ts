export interface ComponentConstraintFacet {
  type: string;
  metadata?: Record<string, any>;
}

export interface PriorityConstraintFacet extends ComponentConstraintFacet {
  type: 'priority';
  priority: number;
  source?: string;
}

/**
 * Constraint to run before all components of a given type (class name)
 */
export interface BeforeComponentTypeConstraint extends ComponentConstraintFacet {
  type: 'before-component-type';
  targetType: string;
  source?: string;
}

/**
 * Constraint to run after all components of a given type (class name)
 */
export interface AfterComponentTypeConstraint extends ComponentConstraintFacet {
  type: 'after-component-type';
  targetType: string;
  source?: string;
}

/**
 * Constraint to run before a specific component by ID
 */
export interface BeforeComponentIdConstraint extends ComponentConstraintFacet {
  type: 'before-component-id';
  targetId: string;
  source?: string;
}

/**
 * Constraint to run after a specific component by ID
 */
export interface AfterComponentIdConstraint extends ComponentConstraintFacet {
  type: 'after-component-id';
  targetId: string;
  source?: string;
}

export type ConstraintFacet =
  | PriorityConstraintFacet
  | BeforeComponentTypeConstraint
  | AfterComponentTypeConstraint
  | BeforeComponentIdConstraint
  | AfterComponentIdConstraint
  | ComponentConstraintFacet;

/**
 * Standard priority levels for FLEX components.
 * These are conventions, not enforced values.
 */
export const ComponentPriority = {
  MODULATOR: 0,
  RECEPTOR: 100,
  TRANSFORM: 200,
  EFFECTOR: 300,
  MAINTAINER: 400
} as const;

/**
 * Create a priority constraint for component ordering.
 * Lower priority values execute earlier in the frame.
 *
 * @param priority - The priority value (lower = earlier execution)
 * @param source - Optional source identifier for debugging
 * @returns A PriorityConstraintFacet
 *
 * @example
 * class MyReceptor extends Component {
 *   protected constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
 * }
 */
export function priorityConstraint(priority: number, source?: string): PriorityConstraintFacet {
  return { type: 'priority', priority, source };
}

/**
 * Create a constraint to run before all components of a given type.
 *
 * @param targetType - Class name of the target component type
 * @param source - Optional source identifier for debugging
 *
 * @example
 * class MyTransform extends Component {
 *   constraints = [beforeComponentType('Effector')];
 * }
 */
export function beforeComponentType(targetType: string, source?: string): BeforeComponentTypeConstraint {
  return { type: 'before-component-type', targetType, source };
}

/**
 * Create a constraint to run after all components of a given type.
 *
 * @param targetType - Class name of the target component type
 * @param source - Optional source identifier for debugging
 *
 * @example
 * class MyTransform extends Component {
 *   constraints = [afterComponentType('Receptor')];
 * }
 */
export function afterComponentType(targetType: string, source?: string): AfterComponentTypeConstraint {
  return { type: 'after-component-type', targetType, source };
}

/**
 * Create a constraint to run before a specific component by ID.
 *
 * @param targetId - The ID of the target component
 * @param source - Optional source identifier for debugging
 *
 * @example
 * class MyComponent extends Component {
 *   constraints = [beforeComponentId('persistence-maintainer')];
 * }
 */
export function beforeComponentId(targetId: string, source?: string): BeforeComponentIdConstraint {
  return { type: 'before-component-id', targetId, source };
}

/**
 * Create a constraint to run after a specific component by ID.
 *
 * @param targetId - The ID of the target component
 * @param source - Optional source identifier for debugging
 *
 * @example
 * class MyComponent extends Component {
 *   constraints = [afterComponentId('message-receptor')];
 * }
 */
export function afterComponentId(targetId: string, source?: string): AfterComponentIdConstraint {
  return { type: 'after-component-id', targetId, source };
}


