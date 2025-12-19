/**
 * @deprecated AgentEffector has been consolidated into AgentComponent.
 * This file re-exports AgentComponent as AgentEffector for backwards compatibility.
 *
 * Migration: Replace `new AgentEffector()` with `new AgentComponent()`
 */

export { AgentComponent as AgentEffector } from './agent-component';
