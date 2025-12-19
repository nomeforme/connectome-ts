/**
 * Real Test Helpers
 *
 * These helpers provide actual integration with Discord API and debug server,
 * not mocks or simulations.
 */

import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';

/**
 * Discord test client for sending/reading messages
 */
export class DiscordTestClient {
  private client: Client | null = null;
  private ready: boolean = false;

  async connect(token: string): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Client not initialized'));
        return;
      }

      this.client.once('ready', () => {
        this.ready = true;
        resolve();
      });

      this.client.on('error', (error) => {
        reject(error);
      });

      this.client.login(token).catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.ready = false;
    }
  }

  async sendMessage(channelId: string, content: string): Promise<Message> {
    if (!this.client || !this.ready) {
      throw new Error('Discord client not connected');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    return (channel as TextChannel).send(content);
  }

  async fetchMessages(channelId: string, limit: number = 10): Promise<Message[]> {
    if (!this.client || !this.ready) {
      throw new Error('Discord client not connected');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    const messages = await (channel as TextChannel).messages.fetch({ limit });
    return Array.from(messages.values());
  }

  async waitForMessage(
    channelId: string,
    predicate: (msg: Message) => boolean,
    timeout: number = 10000
  ): Promise<Message | null> {
    if (!this.client || !this.ready) {
      throw new Error('Discord client not connected');
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.client?.off('messageCreate', handler);
        resolve(null);
      }, timeout);

      const handler = (message: Message) => {
        if (message.channelId === channelId && predicate(message)) {
          clearTimeout(timer);
          this.client?.off('messageCreate', handler);
          resolve(message);
        }
      };

      this.client!.on('messageCreate', handler);
    });
  }
}

/**
 * Debug server HTTP client for querying state
 */
export class DebugServerClient {
  private baseUrl: string;

  constructor(host: string = 'localhost', port: number = 3015) {
    this.baseUrl = `http://${host}:${port}`;
  }

  async getState(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/state`);
    if (!response.ok) {
      throw new Error(`Debug server returned ${response.status}`);
    }
    return response.json();
  }

  async getVEILState(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/facets`);
    if (!response.ok) {
      throw new Error(`Debug server returned ${response.status}`);
    }
    return response.json();
  }

  async getFrames(limit: number = 20, offset: number = 0): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/api/frames?limit=${limit}&offset=${offset}`);
    if (!response.ok) {
      throw new Error(`Debug server returned ${response.status}`);
    }
    const data = await response.json();
    return data.frames || [];
  }

  async getFrame(frameId: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/frames/${frameId}`);
    if (!response.ok) {
      throw new Error(`Debug server returned ${response.status}`);
    }
    return response.json();
  }

  async injectEvent(topic: string, payload: any, sourceId: string = 'test'): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, payload, sourceId })
    });
    if (!response.ok) {
      throw new Error(`Debug server returned ${response.status}`);
    }
    return response.json();
  }

  async getMetrics(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/metrics`);
    if (!response.ok) {
      throw new Error(`Debug server returned ${response.status}`);
    }
    return response.json();
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/state`, {
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getElementTree(componentId?: string, depth?: number): Promise<any> {
    // Use /api/state to get the space structure
    // The debug server returns space.children which is the element tree
    const state = await this.getState();
    return state.space || {};
  }

  async getElement(componentId: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/elements/${componentId}`);
    if (!response.ok) {
      throw new Error(`Debug server returned ${response.status}`);
    }
    return response.json();
  }

  async getAgents(): Promise<any[]> {
    // Agents are elements with agent components
    // We can extract them from the space structure
    const state = await this.getState();
    const agents: any[] = [];

    // Check top-level space components for agents
    if (state.space?.components) {
      const agentComps = state.space.components.filter((c: any) =>
        c.type?.toLowerCase().includes('agent')
      );
      agents.push(...agentComps.map((c: any) => ({
        id: c.id,
        name: c.type,
        type: 'agent',
        status: 'active'
      })));
    }

    // Check children for agent elements
    if (state.space?.children) {
      const agentElements = state.space.children.filter((e: any) =>
        e.name?.toLowerCase().includes('agent') ||
        e.components?.some((c: any) => c.type?.toLowerCase().includes('agent'))
      );
      agents.push(...agentElements.map((e: any) => ({
        id: e.id,
        name: e.name,
        type: 'agent',
        status: 'active'
      })));
    }

    return agents;
  }

  async getComponents(): Promise<any[]> {
    // Get all components from the space structure
    const state = await this.getState();
    const components: any[] = [];

    // Add top-level space components
    if (state.space?.components) {
      components.push(...state.space.components.map((c: any) => ({
        name: c.type,
        type: c.martemPhase || 'component',
        id: c.id,
        componentId: c.id
      })));
    }

    // Add components from all child elements
    if (state.space?.children) {
      for (const child of state.space.children) {
        if (child.components) {
          components.push(...child.components.map((c: any) => ({
            name: c.type,
            type: c.martemPhase || 'component',
            id: c.id,
            componentId: child.id
          })));
        }
      }
    }

    return components;
  }
}

/**
 * Helper to wait for a condition with polling
 */
export async function waitForCondition(
  condition: () => Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  return false;
}

/**
 * Helper to wait for frames containing specific data
 */
export async function waitForFrame(
  debugClient: DebugServerClient,
  predicate: (frame: any) => boolean,
  timeout: number = 5000
): Promise<any | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const frames = await debugClient.getFrames(20);
    const found = frames.find(predicate);
    if (found) {
      return found;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return null;
}

/**
 * Helper to wait for VEIL facet
 */
export async function waitForFacet(
  debugClient: DebugServerClient,
  predicate: (facet: any) => boolean,
  timeout: number = 5000
): Promise<any | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const veilState = await debugClient.getVEILState();

    // Facets come as array of [key, facetObject] tuples from the API
    const facets = Array.isArray(veilState.facets)
      ? veilState.facets.map((tuple: any) => tuple[1]) // Extract facet object from tuple
      : Object.values(veilState.facets || {});

    const found = facets.find(predicate);
    if (found) {
      return found;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return null;
}
