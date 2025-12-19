/**
 * AgentElement - A specialized Element for hosting agents
 * 
 * This ensures proper element type identification for 
 * frame attribution and debugging.
 */

import { Component } from '../spaces/component';

export class AgentElement extends Component {
  constructor(name: string, id?: string) {
    super();
    this.id = id || `agent-element-${Date.now()}`;
    // name property doesn't exist on Component, maybe store it elsewhere or just ignore
  }
  
  /**
   * Override getRef to include proper element type
   */
  public getRef() {
    const ref = super.getRef();
    return {
      ...ref,
      componentType: 'AgentElement'
    };
  }
}


