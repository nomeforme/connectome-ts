export function normalizeFrame(frame) {
  return {
    events: [],
    deltas: [],
    renderedContext: null,
    ...frame,
    events: frame.events ? [...frame.events] : [],
    deltas: frame.deltas ? [...frame.deltas] : [],
    kind: frame.kind || 'incoming'
  };
}

export function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

export function cloneFacetsTree(tree) {
  if (!tree) return [];
  return JSON.parse(JSON.stringify(tree));
}

export const ACTION_SNIPPET_REGEX = /@[a-zA-Z0-9_.-]+(?:\([^@\n]*?\))?/g;

export function extractActionSnippets(facets) {
  if (!Array.isArray(facets) || facets.length === 0) {
    return [];
  }

  const snippets = new Map();

  const addSnippet = (snippet, facet) => {
    if (!snippet) return;
    const normalized = snippet.trim();
    if (!normalized) return;
    if (snippets.has(normalized)) return;
    snippets.set(normalized, {
      text: normalized,
      source: facet.displayName || facet.id || facet.type || null,
      facetId: facet.id || null,
      facetType: facet.type || null
    });
  };

  const scanValue = (value, facet) => {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      let match;
      while ((match = ACTION_SNIPPET_REGEX.exec(value)) !== null) {
        addSnippet(match[0], facet);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        scanValue(item, facet);
      }
    } else if (typeof value === 'object') {
      for (const key of Object.keys(value)) {
        scanValue(value[key], facet);
      }
    }
  };

  const walkFacet = facet => {
    if (!facet || typeof facet !== 'object') {
      return;
    }
    scanValue(facet.content, facet);
    scanValue(facet.displayName, facet);
    scanValue(facet.attributes, facet);
    scanValue(facet.scope, facet);
    scanValue(facet.saliency, facet);
    if (Array.isArray(facet.children)) {
      for (const child of facet.children) {
        walkFacet(child);
      }
    }
  };

  for (const facet of facets) {
    walkFacet(facet);
  }

  return Array.from(snippets.values());
}

const DEBUG_LOGGING = true;

export function debugLog(...args) {
  if (!DEBUG_LOGGING) return;
  try {
    console.log('[DebugUI]', ...args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[DebugUI]', args);
  }
}

export function formatTimestamp(value) {
  if (!value) return '—';
  try {
    const date = new Date(value);
    return date.toLocaleString();
  } catch {
    return value;
  }
}

export function formatTime(value) {
  if (!value) return '—';
  try {
    const date = new Date(value);
    return date.toLocaleTimeString();
  } catch {
    if (typeof value === 'number') {
      return `${value} ms`;
    }
    return value;
  }
}

export function shorten(value, max = 28) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function truncate(value, max = 160) {
  if (!value && value !== 0) return '';
  const str = String(value);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function formatComponents(components, maxCount = 3) {
  if (!components?.length) return '';
  const names = components.map(c => c.name || c.id || c.type || 'component');
  if (names.length <= maxCount) {
    return names.join(', ');
  }
  return `${names.slice(0, maxCount).join(', ')} +${names.length - maxCount}`;
}

export function formatChildren(children, maxCount = 2) {
  if (!children?.length) return '';
  const items = children.map((c, idx) => {
    if (c.content && c.content.length > 20) {
      return truncate(c.content, 30);
    }
    const name = c.name || c.id || (c.content ? truncate(c.content, 15) : null) || `${c.type || 'child'}${idx + 1}`;
    const type = c.type || 'unknown';
    return c.name || c.id ? `${name}(${type})` : name;
  });
  if (items.length <= maxCount) {
    return items.join(' > ');
  }
  return `${items.slice(0, maxCount).join(' > ')} +${items.length - maxCount}`;
}

export function summarizeFacet(facet) {
  if (!facet) return '';
  if (facet.content) return facet.content;
  const keys = Object.keys(facet.attributes || {});
  if (keys.length) {
    return keys.map(key => `${key}: ${stringify(facet.attributes[key])}`).join('\n');
  }
  return facet.displayName || facet.id || '(empty)';
}

export function summarizeOperation(op) {
  if (!op) return '';
  switch (op.type) {
    case 'addFacet':
      return `addFacet → ${op.facet?.displayName || op.facet?.id || 'facet'} (${op.facet?.type || '?'})`;
    case 'changeState':
      return `changeState → ${op.facetId}`;
    case 'addStream':
      return `addStream → ${op.stream?.id || op.streamId}`;
    case 'agentActivation':
      return `agentActivation (${op.priority || 'normal'})`;
    case 'speak':
      return `speak → ${shorten(op.content || '', 80)}`;
    default:
      return op.type;
  }
}

export function operationMeta(op) {
  if (!op) return '';
  switch (op.type) {
    case 'addFacet':
      return shorten(op.facet?.displayName || op.facet?.type || '', 32);
    case 'changeState': {
      const keys = Object.keys(op.updates?.attributes || {});
      return keys.length ? `attrs: ${shorten(keys.join(', '), 36)}` : '';
    }
    case 'agentActivation':
      return shorten(op.reason || op.source || '', 36);
    case 'addStream':
      return shorten(op.stream?.name || op.stream?.id || '', 36);
    case 'speak':
      return shorten(op.target || (op.targets && op.targets.join(', ')) || '', 36);
    default:
      return '';
  }
}

export function summarizeEvent(event) {
  if (!event) return '';
  const targetPath = event.target?.elementPath?.join('/') || event.target?.elementId;
  const sourcePath = event.source?.elementPath?.join('/') || event.source?.elementId;
  const target = targetPath || sourcePath;
  return target ? `${event.topic} → ${target}` : event.topic || 'event';
}

export function eventMeta(event) {
  if (!event) return '';
  const parts = [];
  if (event.phase && event.phase !== 'none') parts.push(event.phase);
  if (event.payload && typeof event.payload === 'object') {
    if (event.payload.reason) parts.push(event.payload.reason);
    if (event.payload.priority) parts.push(`priority ${event.payload.priority}`);
  }
  return shorten(parts.join(' · '), 40);
}

export function formatComponentSummary(state) {
  if (!state || typeof state !== 'object') return '';
  const entries = Object.entries(state)
    .slice(0, 2)
    .map(([key, value]) => {
      const formatted = typeof value === 'object' ? JSON.stringify(value) : value;
      return `${key}: ${shorten(formatted, 36)}`;
    });
  return entries.join(' · ');
}

export function getTurnLabel(turnType, counter) {
  switch (turnType) {
    case 'agent-speech': return `🗣️ Agent Turn ${counter}`;
    case 'agent-action': return `⚡ Agent Actions ${counter}`;
    case 'agent-thought': return `💭 Agent Thoughts ${counter}`;
    case 'agent-other': return `🤖 Agent Activity ${counter}`;
    case 'external-event': return `📨 External Events ${counter}`;
    case 'state-update': return `📊 State Changes ${counter}`;
    case 'external-other': return `🌐 External Activity ${counter}`;
    default: return `📝 Activity ${counter}`;
  }
}
