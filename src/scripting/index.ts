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

// TODO: Export components as they are implemented
// export { ScriptExecutorEffector } from './script-executor';
// export { ToolRegistry } from './tool-registry';
// export { createSandboxedLuaState } from './lua-sandbox';
