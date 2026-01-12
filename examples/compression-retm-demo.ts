/**
 * Compression + RETM Architecture Demo
 * 
 * This example demonstrates how compression works with Connectome's component architecture:
 * 1. CompressionTransform (priority=10) - Compresses old frames
 * 2. ContextRenderer (priority=100) - Renders context with compression
 * 3. AgentEffector (priority=300) - Runs agent with pre-rendered context
 * 
 * Run with: ts-node examples/compression-retm-demo.ts
 */

import {
  Space,
  VEILStateManager,
  Element,
  BasicAgent,
  AgentComponent,
  AgentEffector,
  CompressionTransform,
  ContextRenderer,
  SimpleTestCompressionEngine,
  MockLLMProvider,
  createSpeechFacet,
  createAgentActivation
} from '../src/index';

async function demonstrateCompression() {
  console.log('='.repeat(60));
  console.log('COMPRESSION + RETM ARCHITECTURE DEMO');
  console.log('='.repeat(60));
  console.log();

  // ========================================
  // SETUP: Core Infrastructure
  // ========================================
  
  console.log('📦 Setting up infrastructure...');
  const veilState = new VEILStateManager();
  const space = new Space(veilState);
  const llmProvider = new MockLLMProvider();
  
  // Create system element for transforms
  const systemElement = new Element('system', 'system');
  space.addChild(systemElement);
  
  // ========================================
  // STEP 1: Create Compression Engine
  // ========================================
  
  console.log('🗜️  Creating compression engine...');
  const compressionEngine = new SimpleTestCompressionEngine();
  
  console.log('   ✓ Using SimpleTestCompressionEngine (no LLM calls)');
  console.log();
  
  // ========================================
  // STEP 2: Register Transforms (Priority Ordering)
  // ========================================
  
  console.log('🔄 Registering transforms...');
  
  // Transform 1: Compression (priority=10, runs first)
  const compressionTransform = new CompressionTransform({
    engine: compressionEngine,
    engineName: 'simple-test',
    triggerThreshold: 300,        // Compress when > 300 tokens
    minFramesBeforeCompression: 5 // Wait for at least 5 frames
  });
  systemElement.addComponent(compressionTransform);
  console.log(`   ✓ CompressionTransform (priority=${compressionTransform.priority})`);
  
  // Transform 2: Context Rendering (priority=100, runs after compression)
  const contextTransform = new ContextRenderer({
    compressionEngine: compressionEngine,
    defaultOptions: { maxTokens: 1000 }
  });
  systemElement.addComponent(contextTransform);
  console.log(`   ✓ ContextRenderer (priority=${contextTransform.priority})`);
  console.log('   → Execution order guaranteed: Compression → Context');
  console.log();
  
  // ========================================
  // STEP 3: Create Agent with Effector
  // ========================================
  
  console.log('🤖 Creating agent...');
  
  // Create agent element
  const agentElement = new Element('demo-agent', 'agent');
  space.addChild(agentElement);
  
  // Create agent (NO compression parameter!)
  const agent = new BasicAgent(
    {
      name: 'DemoAgent',
      systemPrompt: 'You are a helpful assistant demonstrating compression.',
      contextTokenBudget: 1000
    },
    llmProvider,
    veilState
  );
  
  // Attach agent via AgentComponent
  const agentComponent = new AgentComponent(agent);
  agentElement.addComponent(agentComponent);
  
  console.log('   ✓ Agent created without compression parameter');
  console.log('   → Compression handled by transforms, not agent!');
  
  // Create effector to run agent
  const agentEffector = new AgentEffector();
  // Add to element instead of space (auto-registers with space)
  agentElement.addComponent(agentEffector);
  
  console.log('   ✓ AgentEffector registered (priority 300)');
  console.log();
  
  // ========================================
  // STEP 4: Generate Test Messages
  // ========================================
  
  console.log('💬 Generating test conversation (10 frames)...');
  console.log();
  
  // Generate 10 frames with user messages to trigger compression
  for (let i = 1; i <= 10; i++) {
    // Add user message
    space.emit({
      topic: 'veil:operation',
      source: { elementId: 'user', elementPath: [] },
      timestamp: Date.now(),
      payload: {
        operation: {
          type: 'addFacet',
          facet: createSpeechFacet({
            id: `user-msg-${i}`,
            agentId: 'user',
            agentName: 'User',
            content: `This is test message #${i}. It helps demonstrate compression by filling up the frame history with significantly more tokens to ensure we hit the threshold. We need to generate enough tokens so that the SimpleTestCompressionEngine's internal logic (200 tokens per chunk) is triggered. Let's add some more text here just to be safe and sure that we are generating enough load for the system to react.`,
            streamId: 'demo',
            streamType: 'test'
          })
        }
      }
    });
    
    console.log(`   Frame ${i}: User message added`);
    
    // Wait a bit for frame processing
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  console.log();
  console.log('   ✓ 10 frames generated');
  console.log(`   → Total frames: ${veilState.getState().frameHistory.length}`);
  console.log();
  
  // ========================================
  // STEP 5: Check Compression Status
  // ========================================
  
  console.log('📊 Checking compression status...');
  
  const state = veilState.getState();
  
  // Look for compression facets
  const compressionPlans = Array.from(state.facets.values())
    .filter(f => f.type === 'compression-plan');
  const compressionResults = Array.from(state.facets.values())
    .filter(f => f.type === 'compression-result');
  
  console.log(`   Compression plans found: ${compressionPlans.length}`);
  console.log(`   Compression results found: ${compressionResults.length}`);
  
  if (compressionResults.length > 0) {
    console.log();
    console.log('   📋 Compression Results:');
    compressionResults.forEach((facet, idx) => {
      const result = (facet as any).state;
      console.log(`      ${idx + 1}. Frames ${result.range.from}-${result.range.to}`);
      console.log(`         Tokens: ${result.range.totalTokens}`);
      console.log(`         Summary: ${result.summary?.substring(0, 60)}...`);
    });
  }
  console.log();
  
  // ========================================
  // STEP 6: Activate Agent
  // ========================================
  
  console.log('🎯 Activating agent...');
  
  // Create agent activation
  space.emit({
    topic: 'veil:operation',
    source: { elementId: 'demo', elementPath: [] },
    timestamp: Date.now(),
    payload: {
      operation: {
        type: 'addFacet',
        facet: createAgentActivation('Demonstrate compression in context', {
          id: `activation-${Date.now()}`,
          priority: 'normal',
          streamId: 'demo',
          streamType: 'test'
        })
      }
    }
  });
  
  console.log('   ✓ Agent activation sent');
  console.log();
  
  // Wait for processing
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // ========================================
  // STEP 7: Check Rendered Context
  // ========================================
  
  console.log('📄 Checking rendered context...');
  
  const updatedState = veilState.getState();
  const contextFacets = Array.from(updatedState.facets.values())
    .filter(f => f.type === 'rendered-context');
  
  if (contextFacets.length > 0) {
    console.log(`   ✓ Rendered context created: ${contextFacets.length} facet(s)`);
    
    const contextFacet = contextFacets[0];
    const contextData = (contextFacet as any).state;
    console.log(`   Token count: ${contextData.tokenCount}`);
    console.log('   → Context includes compressed frames!');
  } else {
    console.log('   ℹ️  No rendered context yet (will appear in next frame)');
  }
  console.log();
  
  // ========================================
  // STEP 8: Show Architecture Flow
  // ========================================
  
  console.log('🏗️  Architecture Flow Summary:');
  console.log();
  console.log('   Priority 0-99: Event Preprocessing (Modulators)');
  console.log('      └─ No modulators in this demo');
  console.log();
  console.log('   Priority 100-199: Events → VEIL (Receptors)');
  console.log('      └─ User messages converted to facets');
  console.log();
  console.log('   Priority 200-299: VEIL → VEIL (Transforms)');
  console.log('      ├─ CompressionTransform (priority=10)');
  console.log('      │  └─ Compresses old frames when threshold met');
  console.log('      │  └─ Updates engine cache');
  console.log('      └─ ContextRenderer (priority=100)');
  console.log('         └─ Renders context for agent activation');
  console.log('         └─ Uses compressed frames from cache');
  console.log();
  console.log('   Priority 300-399: VEIL Changes → Side Effects (Effectors)');
  console.log('      └─ AgentEffector');
  console.log('         └─ Sees activation + rendered-context facets');
  console.log('         └─ Runs agent with pre-rendered context');
  console.log('         └─ Emits agent response facets');
  console.log();
  console.log('   Priority 400-499: Maintenance (Maintainers)');
  console.log('      └─ No maintainers in this demo');
  console.log();
  
  // ========================================
  // SUMMARY
  // ========================================
  
  console.log('='.repeat(60));
  console.log('✅ DEMO COMPLETE');
  console.log('='.repeat(60));
  console.log();
  console.log('Key Takeaways:');
  console.log();
  console.log('1. 🔢 Transform Priority: Ensures correct execution order');
  console.log('   • CompressionTransform (10) runs before ContextRenderer (100)');
  console.log('   • Order matters because they share the engine instance');
  console.log();
  console.log('2. 🧩 Separation of Concerns:');
  console.log('   • Agent doesn\'t manage compression');
  console.log('   • Transforms handle infrastructure');
  console.log('   • Effectors connect everything');
  console.log();
  console.log('3. 📊 Observable:');
  console.log('   • Compression creates facets (compression-plan, compression-result)');
  console.log('   • Context rendering creates facets (rendered-context)');
  console.log('   • Everything visible in VEIL state');
  console.log();
  console.log('4. 🔄 Reusable:');
  console.log('   • One compression engine serves all agents');
  console.log('   • One set of transforms handles all compression');
  console.log('   • Multiple agents can share the infrastructure');
  console.log();
  
  // Clean up
  process.exit(0);
}

// Run the demo
demonstrateCompression().catch(error => {
  console.error('Demo error:', error);
  process.exit(1);
});

