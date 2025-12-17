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
import { ActivationCompletedReceptor } from './agent/activation-completed-receptor';
import { ActionEffector } from './spaces/action-effector';
import { ContextTransform } from './hud/context-transform';
import { ConsoleChatComponent } from './elements/console-chat';
import { SpaceNotesComponent } from './components/space-notes';
import { AxonLoaderComponent } from './components/axon-loader';

// Scripting components (FLEX architecture)
import { ScriptExecutorEffector } from './scripting/script-executor';
import { ActionResultProcessor } from './scripting/action-result-processor';
import { ActivationDecider } from './scripting/activation-decider';

// Register core components
ComponentRegistry.register('AgentComponent', AgentComponent);
ComponentRegistry.register('AgentEffector', AgentComponent); // Backwards compatibility alias
ComponentRegistry.register('ActivationCompletedReceptor', ActivationCompletedReceptor);
ComponentRegistry.register('ActionEffector', ActionEffector);
ComponentRegistry.register('ContextTransform', ContextTransform);
ComponentRegistry.register('ConsoleChatComponent', ConsoleChatComponent);
ComponentRegistry.register('SpaceNotesComponent', SpaceNotesComponent);
ComponentRegistry.register('AxonLoaderComponent', AxonLoaderComponent);

// Scripting components
ComponentRegistry.register('ScriptExecutorEffector', ScriptExecutorEffector);
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
