#!/usr/bin/env node
import { ConnectomeDebugMCP } from './debug-mcp-server';

async function testDebugMCP() {
  const mcp = new ConnectomeDebugMCP();
  
  console.log('🧪 Testing Connectome Debug MCP...\n');
  
  try {
    // Test 1: Connect to debug server
    console.log('1️⃣ Connecting to debug server on port 4000...');
    const connectResult = await mcp.connect({ port: 4000 });
    console.log('✅ Connected:', connectResult);
    
    // Test 2: Get connection status
    console.log('\n2️⃣ Checking connection status...');
    const status = await mcp.getConnectionStatus();
    console.log('✅ Status:', status);
    
    // Test 3: Get current state
    console.log('\n3️⃣ Getting current state...');
    const state = await mcp.getState();
    console.log('✅ State retrieved');
    console.log('   - Space elements:', countElements(state.space));
    console.log('   - VEIL facets:', Object.keys(state.veil || {}).length);
    console.log('   - Manual LLM enabled:', state.manualLLMEnabled);
    
    // Test 4: Get agents
    console.log('\n4️⃣ Getting agents...');
    const agents = await mcp.getAgents();
    console.log('✅ Agents:', agents.length);
    agents.forEach(agent => {
      console.log(`   - ${agent.id}: ${agent.componentType || 'unknown'}`);
    });
    
    // Test 5: Get frames
    console.log('\n5️⃣ Getting execution frames...');
    const frames = await mcp.getFrames({ limit: 5 });
    console.log('✅ Frames:', frames.frames.length);
    frames.frames.forEach(frame => {
      console.log(`   - ${frame.type}: ${frame.topic || frame.operation?.type || 'unknown'}`);
    });
    
    // Test 6: Search frames
    console.log('\n6️⃣ Searching for "agent" in frames...');
    const searchResults = await mcp.searchFrames({ pattern: 'agent', maxResults: 3 });
    console.log('✅ Search results:', searchResults.matches.length, 'matches found');
    console.log('   - Total searched:', searchResults.totalSearched);
    console.log('   - Truncated:', searchResults.truncated);
    if (searchResults.matches.length > 0) {
      console.log('   - First match context:', searchResults.matches[0].matchContext.substring(0, 80) + '...');
    }
    
    // Test 7: Get metrics
    console.log('\n7️⃣ Getting performance metrics...');
    const metrics = await mcp.getMetrics();
    console.log('✅ Metrics:');
    console.log('   - Total frames:', metrics.totalFrames);
    console.log('   - Operations/sec:', metrics.operationsPerSecond?.toFixed(2));
    console.log('   - Events/sec:', metrics.eventsPerSecond?.toFixed(2));
    
    // Test 8: Inject test event
    console.log('\n8️⃣ Injecting test event...');
    await mcp.injectEvent({
      topic: 'debug.test',
      payload: { message: 'Hello from Debug MCP!' }
    });
    console.log('✅ Event injected');
    
    // Test 9: Disconnect
    console.log('\n9️⃣ Disconnecting...');
    await mcp.disconnect();
    console.log('✅ Disconnected');
    
    console.log('\n🎉 All tests passed!');
    
  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

function countElements(element: any): number {
  if (!element) return 0;
  let count = 1;
  if (element.children) {
    for (const child of element.children) {
      count += countElements(child);
    }
  }
  return count;
}

// Run tests
testDebugMCP();
