import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Read every project-conventions file in scope and return their
 * concatenated body truncated to a prompt budget. Walks upward from
 * the evidence file's directory so nested package rules layer over
 * the workspace default. Cached per-path so a 100-finding scan reads
 * each file once.
 *
 * Why this exists: detectors flag patterns ("duplicate-function",
 * "long-function", "long-file", …) that are intentional in some
 * codebases (Commander.js idiom, linear request handlers, recognizer
 * tables). Encoding every project rule into the detector is impossible
 * — but the project usually writes those rules in a conventions file
 * (CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions.md, …).
 * Feeding them into the LLM verdict makes triage project-aware without
 * touching detector logic.
 *
 * Returns `undefined` when no recognised conventions file is found.
 */
const cache = new Map<string, string | undefined>();
const MAX_LEN = 6000;

/**
 * Filenames (relative to each directory we visit) that count as
 * "project conventions". Ordered roughly by community adoption.
 * Tools-specific files (`.cursorrules`, `.windsurfrules`) are kept in
 * the same list because rules written for one agent usually apply to
 * any agent — they describe project shape, not tool quirks.
 */
const CONVENTION_FILENAMES: string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'AGENT.md',
  'GEMINI.md',
  'CODEX.md',
  '.codex.md',
  'COPILOT.md',
  'AI.md',
  'AI_GUIDELINES.md',
  'AI_RULES.md',
  '.cursorrules',
  '.cursor/rules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
  '.continue/rules.md',
  'CONVENTIONS.md',
  'CODESTYLE.md',
  'STYLEGUIDE.md',
  'CONTRIBUTING.md',
];

export function readProjectConventions(
  workspaceRoot: string,
  evidenceFile?: string,
): string | undefined {
  const dirs: string[] = [];
  // Walk upward from the evidence file's directory to the workspace
  // root, deepest first. Within each directory we read every matching
  // conventions file. Nested rules appear before workspace defaults
  // in the joined output so the LLM sees them as the more specific
  // override.
  if (evidenceFile) {
    const wsAbs = path.resolve(workspaceRoot);
    let dir = path.dirname(path.resolve(workspaceRoot, evidenceFile));
    while (true) {
      dirs.push(dir);
      if (path.resolve(dir) === wsAbs) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } else {
    dirs.push(workspaceRoot);
  }
  const parts: string[] = [];
  let budget = MAX_LEN;
  for (const dir of dirs) {
    for (const name of CONVENTION_FILENAMES) {
      if (budget <= 0) break;
      const candidate = path.join(dir, name);
      let body = cache.get(candidate);
      if (body === undefined && !cache.has(candidate)) {
        body = readFileSafe(candidate);
        cache.set(candidate, body);
      }
      if (!body) continue;
      const wsRel = path.relative(workspaceRoot, candidate) || name;
      const slice = body.length > budget ? body.slice(0, budget) + '\n…(truncated)' : body;
      parts.push(`# ${wsRel}\n${slice}`);
      budget -= slice.length + wsRel.length + 4;
    }
    if (budget <= 0) break;
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n\n---\n\n');
}

function readFileSafe(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return undefined;
  }
}
