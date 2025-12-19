/**
 * Transition-based persistence types
 * Each frame carries a transition object that systems write to during processing
 */

import { ComponentRef } from '../spaces/types';
import { VEILOperation } from '../veil/types';

/**
 * Element tree operation
 */
export type ElementOperation = 
  | { type: 'add-element'; parentRef: ComponentRef; element: { id: string; name: string; type: string } }
  | { type: 'remove-element'; elementRef: ComponentRef }
  | { type: 'move-element'; elementRef: ComponentRef; newParentRef: ComponentRef }
  | { type: 'update-element'; elementRef: ComponentRef; changes: { active?: boolean; subscriptions?: string[] } };

/**
 * Component state change
 */
export interface ComponentChange {
  elementRef: ComponentRef;
  componentType: string;
  componentIndex: number;
  property: string;
  oldValue: any;
  newValue: any;
}

/**
 * Component lifecycle operation
 */
export type ComponentOperation =
  | { type: 'add-component'; elementRef: ComponentRef; componentType: string; initialState?: any }
  | { type: 'remove-component'; elementRef: ComponentRef; componentType: string; componentIndex: number };

/**
 * Frame transition - captures all changes during a frame
 */
export interface FrameTransition {
  sequence: number;
  timestamp: string;
  
  // Element tree changes
  elementOps: ElementOperation[];
  
  // Component changes
  componentOps: ComponentOperation[];
  componentChanges: ComponentChange[];
  
  // VEIL operations (already defined in VEIL)
  veilOps: VEILOperation[];
  
  // Extensible for other systems
  extensions?: Record<string, any>;
}

/**
 * Transition node for branching history
 */
export interface TransitionNode {
  sequence: number;
  parentSequence: number | null;  // null for root
  branchName?: string;
  transition: FrameTransition;
}

/**
 * Snapshot for fast restoration
 */
export interface TransitionSnapshot {
  sequence: number;
  timestamp: string;
  branchName?: string;
  
  // Full state at this point
  elementTree: any;  // Serialized element tree
  componentStates: any;  // Serialized component states
  veilState: any;  // Serialized VEIL state
}

/**
 * Systems that can apply transitions
 */
export interface TransitionApplicator {
  applyTransition(transition: FrameTransition): void;
}

/**
 * Systems that can create snapshots
 */
export interface SnapshotProvider {
  createSnapshot(): any;
  restoreSnapshot(snapshot: any): void;
}
