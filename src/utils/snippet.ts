/**
 * Snippet trimmers shared across the detectors. The cluster confirmers
 * (api-race, shared-db-write, race-condition, …) embed `enclosingSource`
 * blobs in each evidence note — those blobs eat the LLM prompt budget
 * quickly when they're long real-world functions. We collapse + cap them
 * here so every detector applies the same prompt-shape.
 */

/**
 * Collapse whitespace + truncate a single-line snippet. Used for
 * preview strings in finding titles + evidence rows.
 */
export function trimSnippet(text: string, maxChars = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars - 3) + '...' : collapsed;
}

/**
 * Preserve the first/last lines of a long function body, ellipsise the
 * middle. Used for the LLM prompt's `enclosingSource` block — gives the
 * model enough context to see the signature + final return without
 * blowing the token budget on a 200-line method.
 */
export function trimEnclosingSource(full: string, headLines = 40): string {
  const lines = full.split(/\r?\n/);
  if (lines.length <= headLines + 2) return full;
  return [...lines.slice(0, headLines), '  // ...', lines[lines.length - 1] ?? ''].join('\n');
}
