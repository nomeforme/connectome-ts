/**
 * VEIL Operation Receptor - FLEX Architecture
 *
 * Built-in receptor for VEIL operations.
 * Note: Legacy migration adapters have been removed as FLEX is now the standard.
 */

import { Component } from './component';
import { ExecutionContext, SpaceEvent } from './types';
import { VEILDelta } from '../veil/types';
import { ReadonlyVEILState } from './component-types';
import { priorityConstraint, ComponentPriority } from './constraints';
import { noPersist } from '../persistence/decorators';

/**
 * Built-in Receptor for VEIL operations
 *
 * FLEX Component (constraint: priority 100 - Receptor level)
 * Processes veil:operation events and adds the delta directly
 */
@noPersist
export class VEILOperationReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
  topics = ['veil:operation'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'veil:operation') return;

    const payload = event.payload as { operation: VEILDelta };
    const { operation } = payload;

    // Add the delta directly
    this.addOperation(operation);
  }
}
