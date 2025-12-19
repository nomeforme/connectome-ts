/**
 * StreamAbortRegistry - Manages AbortControllers for streaming activations
 *
 * This registry allows ResponseHandler to signal AgentComponent to abort
 * a streaming activation when a tool call is detected mid-stream.
 *
 * Flow:
 * 1. AgentComponent registers an AbortController before starting a stream
 * 2. ResponseHandler looks up the controller when it detects a tool call
 * 3. ResponseHandler calls abort() on the controller
 * 4. The abort signal propagates to the LLM provider to stop the stream
 * 5. AgentComponent cleans up the registration when the stream ends
 *
 * The registry is a singleton to enable cross-component communication
 * without direct dependencies.
 */

export interface StreamAbortEntry {
  controller: AbortController;
  activationId: string;
  agentId: string;
  registeredAt: number;
}

class StreamAbortRegistryImpl {
  private entries = new Map<string, StreamAbortEntry>();

  /**
   * Register an AbortController for a streaming activation
   *
   * @param activationId - The activation ID being streamed
   * @param agentId - The agent ID producing the stream
   * @returns The AbortController's signal to pass to the LLM provider
   */
  register(activationId: string, agentId: string): AbortSignal {
    // Clean up any existing entry for this activation
    this.unregister(activationId);

    const controller = new AbortController();
    this.entries.set(activationId, {
      controller,
      activationId,
      agentId,
      registeredAt: Date.now()
    });

    console.log(`[StreamAbortRegistry] Registered abort controller for ${activationId}`);
    return controller.signal;
  }

  /**
   * Abort a streaming activation
   *
   * @param activationId - The activation ID to abort
   * @param reason - Optional reason for the abort
   * @returns true if the activation was found and aborted, false otherwise
   */
  abort(activationId: string, reason?: string): boolean {
    const entry = this.entries.get(activationId);
    if (!entry) {
      console.warn(`[StreamAbortRegistry] No entry found for ${activationId}`);
      return false;
    }

    console.log(`[StreamAbortRegistry] Aborting ${activationId}: ${reason || 'tool call detected'}`);
    entry.controller.abort(reason);
    return true;
  }

  /**
   * Check if an activation has been aborted
   */
  isAborted(activationId: string): boolean {
    const entry = this.entries.get(activationId);
    return entry?.controller.signal.aborted ?? false;
  }

  /**
   * Get the AbortSignal for an activation (for checking abort status)
   */
  getSignal(activationId: string): AbortSignal | undefined {
    return this.entries.get(activationId)?.controller.signal;
  }

  /**
   * Unregister an activation (called when stream completes or is cleaned up)
   */
  unregister(activationId: string): void {
    if (this.entries.delete(activationId)) {
      console.log(`[StreamAbortRegistry] Unregistered ${activationId}`);
    }
  }

  /**
   * Get all active entries (for debugging)
   */
  getActiveEntries(): Map<string, StreamAbortEntry> {
    return new Map(this.entries);
  }

  /**
   * Clear all entries (for testing)
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Clean up stale entries older than the given age in milliseconds
   * (safety mechanism for entries that weren't properly cleaned up)
   */
  cleanupStale(maxAgeMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [activationId, entry] of this.entries) {
      if (now - entry.registeredAt > maxAgeMs) {
        console.warn(`[StreamAbortRegistry] Cleaning up stale entry ${activationId}`);
        this.entries.delete(activationId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

// Singleton instance
export const StreamAbortRegistry = new StreamAbortRegistryImpl();

// Export the type for dependency injection / testing
export type { StreamAbortRegistryImpl };
