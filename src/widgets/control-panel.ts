/**
 * Control Panel Widget - DECLARATIVE VERSION
 *
 * A toggleable control panel that manages tool visibility through scoping.
 * Uses declarative pattern: emits events, receptors create facets.
 */

import { InteractiveComponent } from '../components/base-components';
import { persistent } from '../persistence/decorators';
import type { SpaceEvent } from '../spaces/types';

/**
 * Metadata for a registered panel tool
 */
export interface PanelToolMetadata {
  name: string;
  instructions: string;
  description?: string;
  params?: any;
  category?: string;
  scope?: string[];
}

export abstract class ControlPanelComponent extends InteractiveComponent {
  @persistent()
  protected isOpen: boolean = false;

  // Store tool metadata (NOT facets!) - transient, recreated on mount
  private toolsMetadata: PanelToolMetadata[] = [];

  /**
   * Subclasses must provide a unique panel ID
   */
  protected abstract getPanelId(): string;

  /**
   * Subclasses must provide a display name for the panel
   */
  protected abstract getPanelDisplayName(): string;

  /**
   * Called when panel is opened (after scope activated)
   */
  protected abstract onPanelOpened(): Promise<void>;

  /**
   * Called when panel is closed (after scope deactivated)
   */
  protected abstract onPanelClosed(): Promise<void>;

  /**
   * Get the scope ID for this panel's tools
   */
  protected getPanelScope(): string {
    return `panel:${this.getPanelId()}`;
  }

  async onMount(): Promise<void> {
    // Clear tools metadata (in case of remount)
    this.toolsMetadata = [];

    // Register panel control actions (just the handlers, no facets yet)
    this.actions.set('open', async () => { await this.openPanel(); });
    this.actions.set('close', async () => { await this.closePanel(); });

    // Note: Subclasses will call registerPanelTool() in their onMount()
    // After subclass onMount() completes, onMountComplete() will be called
  }

  /**
   * Called after onMount completes - emits event for receptors
   * Override point for Space to call after component mounting
   */
  async onMountComplete(): Promise<void> {
    // Emit event with all registered tools
    // ControlPanelActionsReceptor will create facets declaratively
    console.log(`[ControlPanel:${this.getPanelId()}] Emitting tools-registered event with ${this.toolsMetadata.length} tools`);

    this.emit({
      topic: 'panel:tools-registered',
      timestamp: Date.now(),
      payload: {
        panelId: this.getPanelId(),
        displayName: this.getPanelDisplayName(),
        componentId: this.id,
        componentType: this.constructor.name,
        tools: this.toolsMetadata,
        panelScope: this.getPanelScope()
      }
    });

    // Initialize scope state based on current isOpen state
    // This ensures tools are hidden if panel starts closed
    console.log(`[ControlPanel:${this.getPanelId()}] Initializing scope state: ${this.isOpen ? 'active' : 'inactive'}`);
    this.emit({
      topic: 'panel:scope-change',
      timestamp: Date.now(),
      payload: {
        panelId: this.getPanelId(),
        scope: this.getPanelScope(),
        active: this.isOpen
      }
    });
  }

  async handleEvent(event: SpaceEvent): Promise<void> {
    await super.handleEvent(event);
    // Subclasses can handle their own events
  }

  /**
   * Open the panel - emits event for scope activation
   */
  private async openPanel(): Promise<void> {
    if (this.isOpen) {
      this.addEvent(
        `${this.getPanelDisplayName()} panel is already open`,
        'panel-already-open',
        `${this.getPanelId()}-panel-already-open`
      );
      return;
    }

    this.isOpen = true;

    // Emit scope activation event (declarative!)
    this.emit({
      topic: 'panel:scope-change',
      timestamp: Date.now(),
      payload: {
        panelId: this.getPanelId(),
        scope: this.getPanelScope(),
        active: true
      }
    });

    // Notify that panel opened
    this.addEvent(
      `${this.getPanelDisplayName()} panel opened - additional tools now available`,
      'panel-opened',
      `${this.getPanelId()}-panel-opened`,
      { panelId: this.getPanelId() }
    );

    // Call subclass hook
    await this.onPanelOpened();

    // Re-activate agent so it can continue with new tools visible
    this.reactivateAgent('Panel opened - new tools available');
  }

  /**
   * Close the panel - emits event for scope deactivation
   */
  private async closePanel(): Promise<void> {
    if (!this.isOpen) {
      this.addEvent(
        `${this.getPanelDisplayName()} panel is already closed`,
        'panel-already-closed',
        `${this.getPanelId()}-panel-already-closed`
      );
      return;
    }

    this.isOpen = false;

    // Emit scope deactivation event (declarative!)
    this.emit({
      topic: 'panel:scope-change',
      timestamp: Date.now(),
      payload: {
        panelId: this.getPanelId(),
        scope: this.getPanelScope(),
        active: false
      }
    });

    // Notify that panel closed
    this.addEvent(
      `${this.getPanelDisplayName()} panel closed`,
      'panel-closed',
      `${this.getPanelId()}-panel-closed`,
      { panelId: this.getPanelId() }
    );

    // Call subclass hook
    await this.onPanelClosed();

    // Re-activate agent
    this.reactivateAgent('Panel closed');
  }

  /**
   * Re-activate the agent so it can continue its turn with updated context
   */
  protected reactivateAgent(reason: string): void {
    // Emit activation:create event to trigger agent re-activation
    // This follows the proper FLEX pattern: event → receptor creates facet
    console.log(`[ControlPanel:${this.getPanelId()}] Emitting activation:create: ${reason}`);

    this.emit({
      topic: 'activation:create',
      timestamp: Date.now(),
      payload: {
        reason,
        id: `activation-panel-${this.getPanelId()}-${Date.now()}`,
        priority: 'normal',
        source: `control-panel-${this.getPanelId()}`,
        metadata: {
          trigger: 'control-panel-toggle',
          panelId: this.getPanelId()
        }
      }
    });
  }

  /**
   * Register a panel tool - stores metadata, doesn't create facets
   * Facets will be created declaratively by ControlPanelActionsReceptor
   */
  protected registerPanelTool(
    name: string,
    handler: (params?: any) => Promise<void>,
    instructions: string,
    config?: {
      description?: string;
      params?: any;
      category?: string;
    }
  ): void {
    // Just register the handler
    this.actions.set(name, handler);

    // Store metadata for receptor to process
    this.toolsMetadata.push({
      name,
      instructions,
      description: config?.description,
      params: config?.params,
      category: config?.category || this.getPanelId(),
      scope: [this.getPanelScope()]  // Auto-scope to panel
    });

    console.log(`[ControlPanel:${this.getPanelId()}] Registered tool: ${name} (metadata stored)`);
  }
}
