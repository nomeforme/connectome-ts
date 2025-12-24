/**
 * AXON Environment
 *
 * Provides Component base classes and utilities to AXON modules.
 * All AXON modules should extend Component directly with explicit priority values.
 */

import { Component } from '../spaces/component';
import { VEILComponent, InteractiveComponent } from '../components/base-components';
import { ControlPanelComponent } from '../widgets/control-panel';
import { ControlPanelActionsListener, PanelScopeReceptor } from '../widgets/control-panel-receptors';
import { BaseAfferent } from '../components/base-afferent';
import { SpaceEvent } from '../spaces/types';
import { persistent, persistable } from '../persistence/decorators';
import { external } from '../host/decorators';
import { IAxonEnvironment } from './interfaces';
import {
  FacetDelta,
  ReadonlyVEILState
} from '../spaces/component-types';
import {
  VEILDelta,
  Facet,
  SpeechFacet,
  EventFacet,
  StateFacet,
  ThoughtFacet,
  ActionFacet
} from '../veil/types';
import {
  createEventFacet,
  createSpeechFacet,
  createStateFacet,
  createThoughtFacet,
  createActionFacet,
  createAmbientFacet,
  createAgentActivation
} from '../helpers/factories';

// Re-export WebSocket for components that need it
let WebSocketImpl: any;
try {
  // Try to import ws for Node.js environments
  WebSocketImpl = require('ws');
} catch {
  // Fall back to browser WebSocket if available
  if (typeof WebSocket !== 'undefined') {
    WebSocketImpl = WebSocket;
  }
}

/**
 * Create the AXON environment with all base classes and utilities
 *
 * AXON modules should extend Component directly with explicit priority values:
 * - priority 0: Modulator-level (event preprocessing)
 * - priority 100: Receptor-level (event → facet transformation)
 * - priority 200: Transform-level (facet processing)
 * - priority 300: Effector-level (side effects, external interactions)
 * - priority 400: Maintainer-level (cleanup, persistence)
 */
export function createAxonEnvironment(): IAxonEnvironment {
  return {
    // Component base classes
    Component: Component as any,
    VEILComponent: VEILComponent as any,
    InteractiveComponent: InteractiveComponent as any,


    // Decorators
    persistent,
    persistable,
    external,

    // Type references - SpaceEvent is created as a plain object
    SpaceEvent: class SpaceEvent {
      constructor(
        public topic: string,
        public source: any,
        public payload?: any
      ) {}
    } as any,

    // WebSocket
    WebSocket: WebSocketImpl,



  };
}
