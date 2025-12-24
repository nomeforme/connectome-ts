# Connectome-TS Examples

## Working Examples

### Console Chat
**File:** `console-chat-host.ts` (executable with `#!/usr/bin/env tsx`)

A complete console chat application demonstrating Connectome's component architecture with Host integration.

**Features:**
- ConsoleAfferent for terminal input
- ConsoleInbound for event→facet conversion
- ConsoleOutbound for agent output
- Full persistence and restoration support
- Component-state management via VEIL

**Run:**
```bash
npm run build && ./examples/console-chat-host.ts
# or
tsx examples/console-chat-host.ts [--reset] [--mock]
```

---

### Box Dispenser
**File:** `dispenser-retm.ts` (executable with `#!/usr/bin/env tsx`)

Component architecture demonstrating dynamic element creation, component-state management, and effectors creating elements through events.

**Features:**
- Dynamic box creation via VEIL
- DispenseButtonReceptor and DispenseEffector
- BoxComponent with actions
- Continuation system for element creation
- No @persistent decorators - all state in VEIL

**Run:**
```bash
tsx examples/dispenser-retm.ts
```

---

### Box Dispenser (with Host)
**File:** `dispenser-with-host.ts` (executable with `#!/usr/bin/env tsx`)

Box dispenser using the Host architecture pattern.

**Features:**
- Automatic persistence and restoration
- Debug UI for observability
- LLM provider dependency injection
- Clean separation of concerns

**Run:**
```bash
npm run example:dispenser        # Normal mode
npm run example:dispenser:reset  # Fresh start
npm run example:dispenser:debug  # Manual LLM mode
```

**Documentation:** See `DISPENSER_HOST_GUIDE.md` for detailed usage.

---

### Generic Host Example
**File:** `generic-host-example.ts` (executable with `#!/usr/bin/env tsx`)

Demonstrates the ConnectomeHost pattern for building applications with automatic persistence, debug capabilities, and dependency injection.

**Run:**
```bash
tsx examples/generic-host-example.ts [--reset]
```

---

### Receptor-Effector Pattern
**File:** `receptor-effector-example.ts`

Demonstrates component architecture patterns with priority-based ordering.

---

## Starship Scenario

**Files:**
- `starship-scenario-veil.ts` - VEIL frame data structures
- `starship-scenario-rendered.xml` - Rendered output example

Reference scenario showing how VEIL frames are structured and rendered.

---

## Documentation

- `DISPENSER_HOST_GUIDE.md` - Comprehensive guide for the Box Dispenser with Host
- `agent-awakening-simple.md` - Simple agent awakening documentation

---

## Scripts

- `run-discord-live.sh` - Launch script for Discord integration

---

## Archive

The `archive/` directory contains:
- Outdated test files
- Conceptual examples (non-executable)
- Superseded implementations
- Old test data directories

These are preserved for reference but are not actively maintained.

---

## Creating New Examples

When creating new examples, follow these guidelines:

1. **Make them executable:** Add `#!/usr/bin/env tsx` shebang for standalone examples
2. **Use current architecture:** Follow component patterns with Host when appropriate
3. **Document clearly:** Add inline comments explaining key concepts
4. **Add to this README:** Document what the example demonstrates
5. **Consider npm scripts:** Add to `package.json` for easy running

### Example Template

```typescript
#!/usr/bin/env tsx
/**
 * Example: [Name]
 * 
 * Demonstrates:
 * - [Feature 1]
 * - [Feature 2]
 */

import { config } from 'dotenv';
config();

import { /* ... */ } from '../src';

async function main() {
  // Your example code
}

main().catch(console.error);
```


