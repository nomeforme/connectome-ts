/**
 * Persistence system exports
 */

export * from './types';
export * from './decorators';
export * from './serialization';
// PersistenceManager removed - use PersistenceMaintainer instead
export * from './persistence-maintainer';
export * from './file-storage';
export * from './blob-store';
export * from './blob-migrator';
export * from './restoration';
export * from './transition-manager';
export * from './transition-maintainer';

// Re-export commonly used items
export { persistent, persistable, Serializers } from './decorators';
export { PersistenceMaintainer } from './persistence-maintainer';
export { ComponentRegistry } from './component-registry';
export { restoreFromSnapshot } from './restoration';
export { TransitionManager } from './transition-manager';
export { TransitionMaintainer } from './transition-maintainer';
export type {
  ElementOperation as TransitionElementOperation,
  ComponentChange as TransitionComponentChange,
  TransitionNode,
  TransitionSnapshot,
  TransitionApplicator,
  SnapshotProvider,
  FrameTransition as PersistenceFrameTransition
} from './transition-types';
export type {
  ComponentOperation as TransitionComponentOperation
} from './transition-types';
