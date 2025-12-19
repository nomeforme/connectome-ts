/**
 * IncrementalToolDetector - Detects tool calls in streaming content
 *
 * Scans accumulated content for complete tool call patterns:
 * - {@element.action(...)} or {@element.action { ... }}
 * - <action name="...">...</action>
 * - <tool_call name="...">...</tool_call>
 *
 * Returns the first complete tool call found, along with the content
 * before it (partial response) for continuation context.
 */

export interface DetectedToolCall {
  /** Full matched tool call text */
  fullMatch: string;
  /** Tool name (e.g., "box.open" or "lua") */
  toolName: string;
  /** Raw parameters (unparsed - will be parsed by response-parser) */
  rawParams: string;
  /** Start position in accumulated content */
  startIndex: number;
  /** End position in accumulated content */
  endIndex: number;
  /** The syntax type that matched */
  syntax: 'curly-brace' | 'action-tag' | 'tool-call-tag';
}

export interface ToolDetectionResult {
  /** Whether a complete tool call was found */
  found: boolean;
  /** The detected tool call (if found) */
  toolCall?: DetectedToolCall;
  /** Content before the tool call (partial response) */
  contentBefore?: string;
  /** Content after the tool call (remaining) */
  contentAfter?: string;
  /** Whether there might be a partial tool call at the end */
  potentialPartial: boolean;
}

/**
 * Patterns for tool call detection
 *
 * Note: These patterns are intentionally conservative - they only match
 * complete, well-formed tool calls. Partial matches at chunk boundaries
 * are detected separately to avoid premature triggering.
 */
const TOOL_PATTERNS = {
  // {@element.action(...)} or {@element.action { ... }} or just {@element.action}
  curlyBrace: /\{@([\w.-]+)(?:\s*\(([^)]*)\)|\s*\{([\s\S]*?)\})?\}/,

  // <action name="...">...</action>
  actionTag: /<action\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/action>/,

  // <tool_call name="...">...</tool_call>
  toolCallTag: /<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/,
};

/**
 * Patterns that indicate a potential partial tool call at the end
 * (content that could be the start of a tool call but isn't complete yet)
 */
const PARTIAL_INDICATORS = [
  /\{@[\w.-]*$/, // Start of curly brace syntax
  /\{@[\w.-]+\s*\([^)]*$/, // Curly brace with incomplete params
  /\{@[\w.-]+\s*\{[^}]*$/, // Curly brace with incomplete block params
  /<action\s*$/, // Start of action tag
  /<action\s+[^>]*$/, // Incomplete action tag opening
  /<action\s+name="[^"]*"[^>]*>[^<]*$/, // Action tag without closing
  /<tool_call\s*$/, // Start of tool_call tag
  /<tool_call\s+[^>]*$/, // Incomplete tool_call tag
  /<tool_call\s+name="[^"]*">[^<]*$/, // tool_call without closing
];

/**
 * Detect tool calls in accumulated content
 *
 * @param content - The accumulated streaming content to scan
 * @param toolMode - 'sync' enables detection, 'async' disables it
 * @returns Detection result with tool call info if found
 */
export function detectToolCall(content: string, toolMode: 'sync' | 'async' = 'sync'): ToolDetectionResult {
  // In async mode, never detect tools (let full response complete)
  if (toolMode === 'async') {
    return { found: false, potentialPartial: false };
  }

  // Protect backticked content from being detected as tool calls
  const backtickPlaceholders: Array<{ placeholder: string; original: string; start: number }> = [];
  let protectedContent = content;
  let offset = 0;

  const backtickRegex = /`[^`]+`/g;
  let match;
  while ((match = backtickRegex.exec(content)) !== null) {
    const placeholder = `__BACKTICK_${backtickPlaceholders.length}__`;
    backtickPlaceholders.push({
      placeholder,
      original: match[0],
      start: match.index
    });
    // Replace in protected content (adjusting for previous replacements)
    const adjustedIndex = match.index - offset;
    protectedContent = protectedContent.slice(0, adjustedIndex) + placeholder + protectedContent.slice(adjustedIndex + match[0].length);
    offset += match[0].length - placeholder.length;
  }

  // Try each pattern in order of priority
  const patterns: Array<{ regex: RegExp; syntax: DetectedToolCall['syntax']; extractName: (m: RegExpExecArray) => string; extractParams: (m: RegExpExecArray) => string }> = [
    {
      regex: TOOL_PATTERNS.curlyBrace,
      syntax: 'curly-brace',
      extractName: (m) => m[1],
      extractParams: (m) => m[2] || m[3] || ''
    },
    {
      regex: TOOL_PATTERNS.actionTag,
      syntax: 'action-tag',
      extractName: (m) => m[1],
      extractParams: (m) => m[2] + (m[3] ? `\n${m[3]}` : '')
    },
    {
      regex: TOOL_PATTERNS.toolCallTag,
      syntax: 'tool-call-tag',
      extractName: (m) => m[1],
      extractParams: (m) => m[2]
    }
  ];

  let earliestMatch: { match: RegExpExecArray; pattern: typeof patterns[0] } | null = null;

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.regex.source, 'g');
    const patternMatch = regex.exec(protectedContent);

    if (patternMatch) {
      if (!earliestMatch || patternMatch.index < earliestMatch.match.index) {
        earliestMatch = { match: patternMatch, pattern };
      }
    }
  }

  if (earliestMatch) {
    const { match: m, pattern } = earliestMatch;

    // Calculate actual positions (restore from protected content)
    // For simplicity, since we're only detecting the first match,
    // we can use the original content positions if before any backtick
    let startIndex = m.index;
    let endIndex = m.index + m[0].length;

    // Adjust for backtick placeholders before this position
    for (const bp of backtickPlaceholders) {
      if (bp.start < startIndex) {
        const diff = bp.original.length - bp.placeholder.length;
        startIndex += diff;
        endIndex += diff;
      }
    }

    // Restore the original match text from content
    const fullMatch = content.slice(startIndex, endIndex);

    return {
      found: true,
      toolCall: {
        fullMatch,
        toolName: pattern.extractName(m),
        rawParams: pattern.extractParams(m),
        startIndex,
        endIndex,
        syntax: pattern.syntax
      },
      contentBefore: content.slice(0, startIndex),
      contentAfter: content.slice(endIndex),
      potentialPartial: false
    };
  }

  // Check for potential partial tool calls at the end
  const potentialPartial = PARTIAL_INDICATORS.some(pattern => pattern.test(protectedContent));

  return {
    found: false,
    potentialPartial
  };
}

/**
 * Check if content might have a partial tool call at the end
 * This is used to avoid emitting completion too early when a tool call
 * might be in progress but not yet complete
 */
export function hasPotentialPartialToolCall(content: string): boolean {
  return PARTIAL_INDICATORS.some(pattern => pattern.test(content));
}
