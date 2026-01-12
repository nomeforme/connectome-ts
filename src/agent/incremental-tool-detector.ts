/**
 * IncrementalToolDetector - Detects tool calls in streaming content
 *
 * Scans accumulated content for complete tool call patterns:
 * - <cnctm:action name="...">...</cnctm:action>
 * - <cnctm:function_calls><cnctm:invoke name="...">...</cnctm:invoke></cnctm:function_calls>
 *
 * The cnctm: prefix is the Connectome namespace, similar to Anthropic's antml: prefix.
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
  syntax: 'cnctm-action' | 'cnctm-invoke';
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
 * All patterns use the cnctm: namespace prefix (similar to Anthropic's antml: prefix).
 * This makes tool calls clearly identifiable and avoids conflicts with user content.
 */
const TOOL_PATTERNS = {
  // <cnctm:action name="...">...</cnctm:action> (primary format)
  cnctmActionTag: /<cnctm:action\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/cnctm:action>/,

  // <cnctm:function_calls><cnctm:invoke name="...">...</cnctm:invoke></cnctm:function_calls>
  // (Anthropic-style format with Connectome namespace)
  cnctmInvokeTag: /<cnctm:function_calls>\s*<cnctm:invoke\s+name="([^"]+)">([\s\S]*?)<\/cnctm:invoke>\s*<\/cnctm:function_calls>/,
};

/**
 * Patterns that indicate a potential partial tool call at the end
 * (content that could be the start of a tool call but isn't complete yet)
 */
const PARTIAL_INDICATORS = [
  /<cnctm:action\s*$/, // Start of cnctm:action tag
  /<cnctm:action\s+[^>]*$/, // Incomplete cnctm:action tag opening
  /<cnctm:action\s+name="[^"]*"[^>]*>[^<]*$/, // cnctm:action without closing
  /<cnctm:function_calls\s*$/, // Start of cnctm:function_calls
  /<cnctm:function_calls>\s*<cnctm:invoke\s*$/, // Start of cnctm:invoke
  /<cnctm:function_calls>\s*<cnctm:invoke\s+[^>]*$/, // Incomplete cnctm:invoke
  /<cnctm:function_calls>\s*<cnctm:invoke\s+name="[^"]*">[^<]*$/, // cnctm:invoke without closing
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
      regex: TOOL_PATTERNS.cnctmInvokeTag,
      syntax: 'cnctm-invoke',
      extractName: (m) => m[1],
      extractParams: (m) => m[2]
    },
    {
      regex: TOOL_PATTERNS.cnctmActionTag,
      syntax: 'cnctm-action',
      extractName: (m) => m[1],
      extractParams: (m) => m[2] + (m[3] ? `\n${m[3]}` : '')
    },
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
