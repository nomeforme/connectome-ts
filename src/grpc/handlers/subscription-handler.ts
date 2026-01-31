/**
 * Subscription Handler for gRPC SubscribeToFacets requests
 * Streams facet changes to connected clients
 */

import { Space } from '../../spaces/space.js';
import { VEILStateManager } from '../../veil/veil-state.js';
import type { Facet, VEILState } from '../../veil/types.js';
import type { FacetDelta } from '../../spaces/receptor-effector-types.js';

/**
 * Subscription request from client
 */
export interface SubscriptionRequest {
  clientId: string;
  filters: Array<{
    types: string[];
    aspectMatch: Record<string, string>;
    attributeMatch: Record<string, string>;
  }>;
  includeExisting: boolean;
  fromSequence: number;
  streamIds: string[];
}

/**
 * Delta to send to client
 */
export interface ClientDelta {
  type: 'added' | 'changed' | 'removed';
  facet: Facet | null;
  oldFacet?: Facet | null;
  sequence: number;
  frameUuid: string;
}

/**
 * Handles facet subscriptions for gRPC clients
 */
export class SubscriptionHandler {
  private space: Space;
  private veilState: VEILStateManager;
  private subscriptions: Map<string, {
    callback: (delta: ClientDelta) => void;
    filters: SubscriptionRequest['filters'];
    streamIds: string[];
    unsubscribe: () => void;
  }> = new Map();

  constructor(space: Space, veilState: VEILStateManager) {
    this.space = space;
    this.veilState = veilState;
  }

  /**
   * Handle a subscription request
   */
  handleSubscribe(
    request: SubscriptionRequest,
    callback: (delta: ClientDelta) => void,
    onEnd: () => void
  ): () => void {
    const { clientId, filters, includeExisting, fromSequence, streamIds } = request;

    console.log(`[SubscriptionHandler] New subscription from ${clientId}`);

    // Send existing facets if requested
    if (includeExisting) {
      const state = this.veilState.getState();
      let facets = Array.from(state.facets.values());

      // Apply filters
      facets = this.applyFilters(facets, filters, streamIds);

      // Send as 'added' deltas
      for (const facet of facets) {
        callback({
          type: 'added',
          facet,
          sequence: state.currentSequence,
          frameUuid: ''
        });
      }
    }

    // Subscribe to state changes
    const unsubscribe = this.veilState.subscribe((state: VEILState) => {
      // Get the latest frame to find changes
      const latestFrame = state.frameHistory[state.frameHistory.length - 1];
      if (!latestFrame) return;

      // Check if we should skip based on fromSequence
      if (fromSequence > 0 && latestFrame.sequence <= fromSequence) {
        return;
      }

      // Process deltas from the frame
      for (const delta of latestFrame.deltas) {
        const clientDelta = this.convertDelta(delta, latestFrame.sequence, latestFrame.uuid || '');

        if (clientDelta && this.matchesFilters(clientDelta.facet, filters, streamIds)) {
          callback(clientDelta);
        }
      }
    });

    // Store subscription
    this.subscriptions.set(clientId, {
      callback,
      filters,
      streamIds,
      unsubscribe
    });

    // Return unsubscribe function
    return () => {
      console.log(`[SubscriptionHandler] Unsubscribing ${clientId}`);
      unsubscribe();
      this.subscriptions.delete(clientId);
      onEnd();
    };
  }

  /**
   * Convert VEIL delta to client delta format
   */
  private convertDelta(delta: any, sequence: number, frameUuid: string): ClientDelta | null {
    switch (delta.type) {
      case 'addFacet':
        return {
          type: 'added',
          facet: delta.facet,
          sequence,
          frameUuid
        };

      case 'rewriteFacet':
        // Get the current facet from state
        const facet = this.veilState.getState().facets.get(delta.id);
        return {
          type: 'changed',
          facet: facet || null,
          oldFacet: null, // Would need to track previous state
          sequence,
          frameUuid
        };

      case 'removeFacet':
        return {
          type: 'removed',
          facet: { id: delta.id, type: 'unknown' } as any, // Minimal info for removal
          sequence,
          frameUuid
        };

      default:
        return null;
    }
  }

  /**
   * Apply filters to a list of facets
   */
  private applyFilters(
    facets: Facet[],
    filters: SubscriptionRequest['filters'],
    streamIds: string[]
  ): Facet[] {
    return facets.filter(f => this.matchesFilters(f, filters, streamIds));
  }

  /**
   * Check if a facet matches the subscription filters
   */
  private matchesFilters(
    facet: Facet | null,
    filters: SubscriptionRequest['filters'],
    streamIds: string[]
  ): boolean {
    if (!facet) return false;

    // Check stream filter
    if (streamIds && streamIds.length > 0) {
      const facetStreamId = (facet as any).streamId;
      if (facetStreamId && !streamIds.includes(facetStreamId)) {
        return false;
      }
    }

    // If no filters, match all
    if (!filters || filters.length === 0) {
      return true;
    }

    // Check if any filter matches (OR logic)
    return filters.some(filter => {
      // Check type filter
      if (filter.types && filter.types.length > 0) {
        if (!filter.types.includes(facet.type)) {
          return false;
        }
      }

      // Check aspect match
      if (filter.aspectMatch && Object.keys(filter.aspectMatch).length > 0) {
        for (const [key, value] of Object.entries(filter.aspectMatch)) {
          if ((facet as any)[key] !== value) {
            return false;
          }
        }
      }

      // Check attribute match
      if (filter.attributeMatch && Object.keys(filter.attributeMatch).length > 0) {
        const attrs = (facet as any).attributes || {};
        for (const [key, value] of Object.entries(filter.attributeMatch)) {
          if (attrs[key] !== value) {
            return false;
          }
        }
      }

      return true;
    });
  }

  /**
   * Get active subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Broadcast a delta to all matching subscriptions
   */
  broadcast(delta: ClientDelta): void {
    for (const [clientId, sub] of this.subscriptions) {
      if (this.matchesFilters(delta.facet, sub.filters, sub.streamIds)) {
        try {
          sub.callback(delta);
        } catch (error) {
          console.error(`[SubscriptionHandler] Error sending to ${clientId}:`, error);
        }
      }
    }
  }
}
