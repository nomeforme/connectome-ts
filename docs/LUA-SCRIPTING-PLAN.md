# Lua Scripting for Connectome

## Overview

This document describes the design for adding Lua scripting capabilities to Connectome, allowing agents to chain multiple tool calls in a single action without spending context tokens on glue logic.

## Motivation

Currently, when an agent needs to perform a sequence of tool calls, each call requires a full round-trip through the LLM:

```
Agent: <action name="getWeather">NYC</action>
[wait for result, context grows]
Agent: <action name="summarize">The weather is...</action>
[wait for result, context grows]
Agent: Here's your summary...
```

With Lua scripting, the agent can express the entire chain in one action:

```lua
<action name="lua">
local weather = getWeather("NYC")
return summarize(weather.forecast)
</action>
```

The script executes within Connectome, calling tools as needed, and only the final result enters the context.

## Why Lua?

- **Designed for embedding**: Lua was created specifically for this "scripting inside a host application" use case
- **Robust sandboxing**: Easy to disable dangerous functionality (os, io, debug libraries)
- **Lightweight**: Small runtime footprint via fengari (Lua in pure JavaScript)
- **LLM familiarity**: While not as fluent as JavaScript, LLMs can write Lua competently
- **Coroutine support**: Native yield/resume for blocking on tool calls

## Core Design

### Hybrid Model: Mutable Status + Separate Results

The design uses a hybrid approach:
- **Action facets** track lifecycle status (mutable: pending → running → blocked → completed)
- **Result facets** contain outcomes (created on completion, immutable)
- **Events** notify of state changes
- **Attribution** via ID references between facets

This mirrors existing Connectome patterns (e.g., `join-channel` action → `channel-joined` event).

### Script Execution Facets

```typescript
// Action: tracks lifecycle (status is mutable)
type ScriptExecutionFacet = {
  type: 'script-execution';
  id: string;
  code: string;                  // Lua source
  agentId: string;               // Who initiated
  parentScriptId: string | null; // null = agent-initiated
  timeoutMs?: number | null;     // Timeout config
  status: ActionStatus;          // pending → running → blocked → completed/error
  blockedOn?: string;            // Tool call we're waiting for
};

// Result: outcome data (created on completion)
type ScriptResultFacet = {
  type: 'script-result';
  id: string;
  scriptId: string;              // Links to ScriptExecutionFacet
  success: boolean;
  result?: unknown;              // Return value
  error?: string;                // Error message
  errorType?: 'lua-error' | 'timeout' | 'interrupted' | 'tool-error';
};
```

### Tool Call Facets

```typescript
// Action: tool call from script (status is mutable)
type ToolCallFacet = {
  type: 'tool-call';
  id: string;
  parentScriptId: string;        // Which script spawned this
  toolName: string;
  args: unknown[];
  status: ActionStatus;          // pending → running → completed/error
};

// Result: tool outcome (created on completion)
type ToolCallResultFacet = {
  type: 'tool-call-result';
  id: string;
  toolCallId: string;            // Links to ToolCallFacet
  parentScriptId: string;        // Denormalized for easy querying
  success: boolean;
  result?: unknown;
  error?: string;
};
```

### Generic Action/Result (for non-script tools)

The pattern generalizes for any action that needs result tracking:

```typescript
type ActionRequestFacet = {
  type: 'action-request';
  id: string;
  actionName: string;
  params?: Record<string, unknown>;
  parentActionId: string | null;
  targetHandler?: string;
  status: ActionStatus;
  blockedOn?: string;
};

type ActionResultFacet = {
  type: 'action-result';
  id: string;
  actionId: string;
  parentActionId: string | null;
  success: boolean;
  result?: unknown;
  error?: string;
  message?: string;
};
```

### Attribution Chain

The `parentScriptId` / `parentActionId` fields create explicit attribution:

```
Agent: <action name="lua">
         local w = getWeather("NYC")
         return summarize(w)
       </action>

┌─────────────────────────────────────┐
│  script-execution                    │
│  id: "script-001"                    │
│  parentScriptId: null                │◄─── Agent-initiated
│  status: blocked                     │
│  blockedOn: "tc-001"                 │
│  code: "local w = getWeather..."     │
└──────────────┬──────────────────────┘
               │ spawns
┌──────────────▼──────────────────────┐
│  tool-call                           │
│  id: "tc-001"                        │
│  parentScriptId: "script-001"        │◄─── Links to parent
│  toolName: "getWeather"              │
│  args: ["NYC"]                       │
│  status: completed                   │
└──────────────┬──────────────────────┘
               │ produces
┌──────────────▼──────────────────────┐
│  tool-call-result                    │
│  id: "tcr-001"                       │
│  toolCallId: "tc-001"                │◄─── Links to request
│  parentScriptId: "script-001"        │
│  success: true                       │
│  result: { temp: 25 }                │
└─────────────────────────────────────┘
```

### How Results Flow Back

1. Script creates `tool-call` facet (status: pending), emits `tool-call:created` event
2. Tool handler sees event, updates facet (status: running), processes request
3. Tool handler creates `tool-call-result` facet, updates tool-call (status: completed)
4. Emits `tool-call:completed` event
5. Script executor sees event, queries result facet by toolCallId
6. Script resumes with result value

```typescript
// Script executor listening for completions
onEvent(event: ToolCallCompletedEvent) {
  if (event.parentScriptId !== this.currentScriptId) return;
  if (event.toolCallId !== this.pendingToolCallId) return;

  // Find the result facet
  const result = this.veil.getFacetsByType('tool-call-result')
    .find(f => f.toolCallId === event.toolCallId);

  // Resume script with result
  this.resumeWith(result.success ? result.result : result.error);
}
```

### Events

Events are notifications; facets are the source of truth:

```typescript
// Script events
type ScriptEvent =
  | { topic: 'script:created'; scriptId: string; parentScriptId: string | null }
  | { topic: 'script:completed'; scriptId: string; success: boolean };

// Tool call events
type ToolCallEvent =
  | { topic: 'tool-call:created'; toolCallId: string; parentScriptId: string; toolName: string }
  | { topic: 'tool-call:completed'; toolCallId: string; parentScriptId: string; success: boolean };

// Generic action events
type ActionEvent =
  | { topic: 'action:created'; actionId: string; actionName: string; parentActionId: string | null }
  | { topic: 'action:completed'; actionId: string; parentActionId: string | null; success: boolean };
```

## Execution Flow

```
Agent Output:
  <action name="lua">
  local weather = getWeather("NYC")
  return summarize(weather)
  </action>

     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frame 1: Action Parsing                                     │
│  ─────────────────────────────────────────────────────────── │
│  ActionParser extracts multiline lua action                  │
│  Emits: agent-action event { name: "lua", content: "..." }   │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frame 2: Script Initialization                              │
│  ─────────────────────────────────────────────────────────── │
│  ScriptExecutorEffector receives action                      │
│  Creates: script-execution facet { id: "s-001",              │
│           status: "running", parentScriptId: null }          │
│  Creates Lua environment, populates tools                    │
│  Runs script... hits getWeather("NYC"), yields               │
│  Creates: tool-call facet { id: "tc-001",                    │
│           parentScriptId: "s-001", status: "pending" }       │
│  Updates s-001: { status: "blocked", blockedOn: "tc-001" }   │
│  Emits: tool-call:created event                              │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frame 3: Tool Execution                                     │
│  ─────────────────────────────────────────────────────────── │
│  WeatherComponent sees tool-call:created for "getWeather"    │
│  Updates tc-001: { status: "running" }                       │
│  Fetches weather data...                                     │
│  Creates: tool-call-result facet { id: "tcr-001",            │
│           toolCallId: "tc-001", success: true,               │
│           result: { temp: 25, conditions: "sunny" } }        │
│  Updates tc-001: { status: "completed" }                     │
│  Emits: tool-call:completed event                            │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frame 4: Script Resumes                                     │
│  ─────────────────────────────────────────────────────────── │
│  ScriptExecutorEffector sees tool-call:completed for tc-001  │
│  Queries tool-call-result facet, gets result value           │
│  Updates s-001: { status: "running" }                        │
│  Resumes Lua coroutine with result value                     │
│  Script continues... hits summarize(weather), yields         │
│  Creates: tool-call facet { id: "tc-002",                    │
│           toolName: "summarize", parentScriptId: "s-001" }   │
│  Updates s-001: { status: "blocked", blockedOn: "tc-002" }   │
│  Emits: tool-call:created event                              │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frame 5: Second Tool Execution                              │
│  ─────────────────────────────────────────────────────────── │
│  SummarizerComponent sees tool-call:created for "summarize"  │
│  Creates: tool-call-result { id: "tcr-002",                  │
│           toolCallId: "tc-002", result: "Weather is mild" }  │
│  Updates tc-002: { status: "completed" }                     │
│  Emits: tool-call:completed event                            │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frame 6: Script Completes                                   │
│  ─────────────────────────────────────────────────────────── │
│  ScriptExecutorEffector sees tool-call:completed for tc-002  │
│  Resumes Lua coroutine, script returns                       │
│  Creates: script-result facet { id: "sr-001",                │
│           scriptId: "s-001", success: true,                  │
│           result: "Weather is mild" }                        │
│  Updates s-001: { status: "completed" }                      │
│  Emits: script:completed event                               │
└─────────────────────────────────────────────────────────────┘
```

## Design Decisions

### Timeouts

- Configurable via action attribute: `<action name="lua" timeout="60000">`
- Default: 30 seconds (configurable)
- Explicit `timeout="0"` allows infinite execution (useful for tickers/daemons)
- On timeout: action transitions to `error` with timeout message

### Parallel Execution

**Explicit non-goal for v1.** Connectome's FLEX architecture is synchronous—frames cannot execute in parallel. Tool calls within a script execute sequentially:

```lua
-- This executes as: getA -> wait -> getB -> wait -> combine
local a = getA()
local b = getB()
return combine(a, b)
```

Future enhancement: A `parallel` built-in tool could spawn multiple child actions and wait for all:

```lua
local results = parallel({
  function() return getA() end,
  function() return getB() end
})
return combine(results[1], results[2])
```

### Script Persistence

- Running/blocked scripts are **not** persisted across restarts
- On application boot, any previously-running actions transition to `interrupted` status:

```typescript
function restoreActions(persisted: ActionFacet[]): ActionFacet[] {
  return persisted.map(action => {
    if (action.status === 'running' || action.status === 'blocked') {
      return {
        ...action,
        status: 'interrupted',
        error: 'Execution interrupted by application shutdown'
      };
    }
    return action;
  });
}
```

- Handling on boot (not save) ensures SIGKILL is handled correctly
- Agent sees interrupted state and can decide whether to retry

### Error Handling

- Lua errors become action errors: `status: 'error'`, `error: 'lua: [string "..."]:5: attempt to index nil value'`
- Scripts can use `pcall` for graceful handling within Lua
- Tool errors are returned to Lua; script decides how to handle

### Security: Sandboxed Environment

Only safe Lua libraries are loaded:

| Loaded | Blocked |
|--------|---------|
| `_G` (base, with restrictions) | `os` |
| `table` | `io` |
| `string` | `debug` |
| `math` | `package` |
| `utf8` | `coroutine` (managed internally) |

Dangerous base functions removed: `dofile`, `loadfile`, `load`, `loadstring`

**Philosophy**: If an app needs OS/filesystem access, provide it via explicit tools with appropriate access controls.

## Parser Amendments

The action parser must support multiline content:

```xml
<action name="lua">
local weather = getWeather("NYC")
local temp = weather.temperature
if temp > 30 then
  return notify("It's hot!", "warning")
else
  return notify("Pleasant weather", "info")
end
</action>
```

Considerations:
- Preserve whitespace/indentation
- Handle edge cases with CDATA: `<action name="lua"><![CDATA[...]]></action>`
- Support `timeout` attribute parsing

## Tool Registry

Scripts are automatically populated with functions matching registered tools:

```typescript
interface IScriptableTool {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
}

interface IToolRegistry {
  getTools(): IScriptableTool[];
  getTool(name: string): IScriptableTool | undefined;
  register(tool: IScriptableTool): void;
}
```

Tools can be auto-imported from HUD tool definitions for consistency.

## Built-in Script Functions

Beyond registered tools, scripts have access to:

| Function | Description |
|----------|-------------|
| `sleep(ms)` | Pause execution for N milliseconds |
| `emit(topic, payload)` | Emit an event into the system |
| `log(...)` | Debug logging (does not enter context) |
| `json.encode(t)` | Serialize table to JSON string |
| `json.decode(s)` | Parse JSON string to table |

## Component Architecture

### ScriptExecutorEffector

Main component handling script lifecycle:

```typescript
class ScriptExecutorEffector extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  private toolRegistry: IToolRegistry;
  private pendingScripts: Map<string, PendingScript>;

  // React to lua actions
  async onAction(action: { name: string; content: string });

  // React to child action completions
  async onActionCompleted(event: ActionCompletedEvent);

  // Internal: create sandboxed Lua state
  private createSandboxedLuaState(): LuaState;

  // Internal: populate tool functions
  private populateToolFunctions(L: LuaState, parentActionId: string);

  // Internal: run/resume coroutine
  private continueScript(pending: PendingScript);
}
```

### ScriptableToolHandler Decorator

Makes existing components respond to script-spawned actions:

```typescript
@ScriptableToolHandler('getWeather')
class WeatherComponent extends Component {
  async executeTool(args: unknown[]): Promise<unknown> {
    const [city] = args as [string];
    return this.fetchWeather(city);
  }
}
```

The decorator handles:
- Listening for pending actions with matching `name`
- Calling `executeTool` with args
- Updating action facet with result/error

## Implementation Phases

| Phase | Description | Files |
|-------|-------------|-------|
| 0 | Documentation (this file) | `docs/LUA-SCRIPTING-PLAN.md` |
| 1 | Core types | `src/scripting/types.ts` |
| 2 | Action parser multiline support | `src/hud/action-parser.ts` |
| 3 | Lua sandbox setup | `src/scripting/lua-sandbox.ts` |
| 4 | Script executor component | `src/scripting/script-executor.ts` |
| 5 | Tool registry & binding | `src/scripting/tool-registry.ts` |
| 6 | Timeout handler | `src/scripting/timeout.ts` |
| 7 | Persistence integration | `src/persistence/action-restore.ts` |
| 8 | Built-in functions | `src/scripting/builtins.ts` |
| 9 | Migrate existing tools | Various component files |

## Future Enhancements

- **Parallel tool execution**: `parallel()` built-in for concurrent child actions
- **Script library imports**: Reusable Lua modules registered by app
- **Streaming results**: Yield intermediate values back to agent context
- **Debugging**: Step-through execution via debug server
- **Resource limits**: Memory caps, instruction count limits

## Generalization: Nested Actions

This design isn't Lua-specific. The action facet model supports any action spawning children:

```xml
<action name="batch">
  <action name="sendMessage" channel="123">Hello</action>
  <action name="addReaction" message="456">thumbsup</action>
</action>
```

The `batch` executor would create child action facets, wait for all to complete, then complete itself. The attribution chain (`parentActionId`) handles it uniformly.
