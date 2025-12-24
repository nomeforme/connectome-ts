/**
 * Register core Connectome components
 * 
 * This file registers built-in components that are part of the
 * Connectome core system. Extension components (like box dispenser)
 * should eventually be loaded via AXON.
 */

import { ComponentRegistry } from './persistence/component-registry';

// Core components
import { AgentComponent } from './agent/agent-component';
import { ActivationCompletedHandler } from './agent/activation-completed-receptor';
import { ResponseHandler } from './agent/response-handler';
import { ActionRouter } from './spaces/action-effector';
import { ContextRenderer } from './hud/context-transform';
import { ConsoleChatComponent } from './elements/console-chat';
import { SpaceNotesComponent } from './components/space-notes';
import { AxonLoaderComponent } from './components/axon-loader';

// Scripting components (FLEX architecture)
import { ScriptRunner } from './scripting/script-executor';
import { ActionResultProcessor } from './scripting/action-result-processor';
import { ActivationDecider } from './scripting/activation-decider';

// Register core components
ComponentRegistry.register('AgentComponent', AgentComponent);
ComponentRegistry.register('AgentEffector', AgentComponent); // Backwards compatibility alias
ComponentRegistry.register('ActivationCompletedHandler', ActivationCompletedHandler);
ComponentRegistry.register('ResponseHandler', ResponseHandler);
ComponentRegistry.register('ActionRouter', ActionRouter);
ComponentRegistry.register('ContextRenderer', ContextRenderer);
ComponentRegistry.register('ConsoleChatComponent', ConsoleChatComponent);
ComponentRegistry.register('SpaceNotesComponent', SpaceNotesComponent);
ComponentRegistry.register('AxonLoaderComponent', AxonLoaderComponent);

// Scripting components
ComponentRegistry.register('ScriptRunner', ScriptRunner);
ComponentRegistry.register('ActionResultProcessor', ActionResultProcessor);
ComponentRegistry.register('ActivationDecider', ActivationDecider);

// Temporary: Register test components
// TODO: Move these to AXON extensions
import { 
  BoxDispenserComponent,
  DispenseButtonComponent
} from './components/box-dispenser';
import { ControlPanelComponent } from './components/control-panel';
import { ContentGeneratorComponent } from './components/content-generator';
import { BoxStateComponent } from './components/box';

// These should be AXON components in the future
ComponentRegistry.register('BoxDispenserComponent', BoxDispenserComponent);
ComponentRegistry.register('ControlPanelComponent', ControlPanelComponent);
ComponentRegistry.register('ContentGeneratorComponent', ContentGeneratorComponent);
ComponentRegistry.register('DispenseButtonComponent', DispenseButtonComponent);
ComponentRegistry.register('BoxStateComponent', BoxStateComponent);

console.log('Core components registered:', ComponentRegistry.getRegisteredNames());
