/**
 * Lua Scripting System
 *
 * Enables agents to chain multiple tool calls in a single action using Lua scripts,
 * reducing context token usage for glue logic between tool calls.
 *
 * @example
 * ```xml
 * <action name="lua">
 * local weather = getWeather("NYC")
 * if weather.temperature > 30 then
 *   return notify("It's hot!", "warning")
 * else
 *   return summarize(weather.forecast)
 * end
 * </action>
 * ```
 *
 * @see docs/LUA-SCRIPTING-PLAN.md for full documentation
 */

// Types
export * from './types';

// Lua Sandbox
export { LuaSandbox, createLuaSandbox, LuaExecutionResult } from './lua-sandbox';

// Script Executor
export { ScriptExecutorEffector, createScriptExecutor } from './script-executor';

// Action Result Processor (Maintainer that emits action:completed events)
export { ActionResultProcessor } from './action-result-processor';

// Activation Decider (decides when to activate the agent based on semantic events)
export { ActivationDecider } from './activation-decider';

// Tool Registry
export {
  ToolRegistry,
  ToolBuilder,
  createToolRegistry,
  getGlobalToolRegistry,
  setGlobalToolRegistry,
  scriptableTool,
  extractScriptableTools,
  // Conversion utilities for agent integration
  toolDefinitionToScriptable,
  toolDefinitionsToScriptable,
  importToolDefinitions,
} from './tool-registry';

// Built-in Functions
export { installBuiltins, getBuiltinNames, BuiltinsOptions } from './builtins';
