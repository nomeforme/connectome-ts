/**
 * Helpers for normalizing `<my_turn>` markers so we only render them once.
 */

const OPEN_TAG = '<my_turn>';

/**
 * Remove any leading/trailing `<my_turn>` wrappers (including duplicates)
 * while preserving interior content newlines.
 */
export function stripTurnMarkers(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

  // Remove any number of opening tags at the front (allow whitespace/newlines between)
  result = result.replace(/^(?:\s*<my_turn>\s*)+/g, '');

  // Remove any number of closing tags at the end
  result = result.replace(/(?:\s*<\/my_turn>\s*)+$/g, '');

  return result;
}

/**
 * Ensure content starts with the open tag exactly once.
 */
export function prependTurnMarkerOnce(content: string, prefix: string = `${OPEN_TAG}\n`): string {
  if (!content.trimStart().startsWith(OPEN_TAG)) {
    return `${prefix}${content}`;
  }
  return content;
}

