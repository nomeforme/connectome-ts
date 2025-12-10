# Session Server Has Moved!

The terminal session server has been extracted to its own repository: `terminal-sessions-mcp`

## New Location

The session server is now located at:
```
../terminal-sessions-mcp/
```

## Why?

This tool is generally useful beyond just Connectome, so we've made it a standalone package that can be used by any project that needs persistent terminal session management with MCP integration.

## Usage from Connectome

The npm scripts have been updated to reference the new location:

```bash
# Start the session server
npm run session-server

# Start with custom port for MCP
npm run session-server:mcp

# Run the MCP stdio server
npm run mcp-server

# Use the CLI
npm run session-cli
```

## Using as a Package

You can also import and use it directly:

```typescript
import { SessionClient } from 'terminal-sessions-mcp';

const client = new SessionClient('ws://localhost:3100');
// ... use the client
```

## Documentation

See the new repository for full documentation:
- `../terminal-sessions-mcp/README.md` - Main documentation
- `../terminal-sessions-mcp/docs/` - Detailed guides
- `../terminal-sessions-mcp/examples/` - Usage examples

## Files Remaining Here

The following test/debug files remain in this directory for Connectome-specific testing:
- `debug-mcp-server.ts`
- `debug-mcp-stdio.ts`
- `test-debug-mcp.ts`
- `test-debug-mcp-tools.md`
- `test-interactive.ts`

All core session server functionality has been moved to the new package.

