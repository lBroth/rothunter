import * as path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Finding } from '../types.js';
import { stableHash } from '../utils/hash.js';
import { escapeForRegex } from '../utils/regex.js';
import { loadGitignore } from '../utils/gitignore.js';

/**
 * todo-comments takes an OPTIONAL files list because the detector
 * walks the workspace itself when omitted — that's how it picks up
 * Python / Go / shell sources the TS parser ignores. The shared
 * `FileWalkingDetectorInput` requires `files`, so this detector keeps
 * its own shape rather than extending.
 */
export interface TodoCommentsDetectorInput {
  workspaceRoot: string;
  /**
   * Optional pre-parsed file list. When omitted, the detector walks the
   * workspace itself — useful for picking up Python / Go / shell files
   * the TS parser does not visit.
   */
  files?: ReadonlyArray<string>;
  /**
   * Recognised markers (case-insensitive). Default covers the common
   * ones used across JS / TS / Go / Rust / Python style guides.
   */
  markers?: ReadonlyArray<string>;
  /**
   * Max findings to emit. Default 60 — these are LOW signal and would
   * otherwise drown the dashboard on legacy repos.
   */
  maxFindings?: number;
}

// Inline TODO/FIXME/HACK/XXX/WTF/BUG/NOTE/REVIEW/DEPRECATED comments.
// HACK/XXX/WTF/FIXME/BUG → MED, rest LOW.
export function detectTodoComments(input: TodoCommentsDetectorInput): Finding[] {
  const markers = input.markers ?? DEFAULT_MARKERS;
  const maxFindings = input.maxFindings ?? 60;
  const findings: Finding[] = [];
  // Build a single alternation regex so we make one pass per file.
  const alt = markers.map((m) => escapeForRegex(m)).join('|');
  const re = new RegExp(`(?:\\/\\/|\\/\\*+|\\#)\\s*(${alt})\\b[:!\\-]?\\s*(.*)`, 'gi');

  // Use the caller-supplied file list when present; otherwise walk the
  // workspace to pick up non-TS sources (Python / Go / shell) the
  // TypeScript parser doesn't visit.
  const files = input.files && input.files.length > 0 ? input.files : walkFiles(input.workspaceRoot);

  for (const rel of files) {
    if (findings.length >= maxFindings) break;
    if (!isAnalysable(rel)) continue;
    const abs = path.resolve(input.workspaceRoot, rel);
    let raw: string;
    try {
      raw = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (findings.length >= maxFindings) break;
      re.lastIndex = 0;
      const m = re.exec(lines[i]!);
      if (!m) continue;
      const marker = m[1]!.toUpperCase();
      const note = (m[2] ?? '').trim().slice(0, 160);
      const line = i + 1;
      const sev = severityFor(marker);
      findings.push({
        detectorId: 'todo-comments',
        severity: sev,
        confidence: 1,
        layer: 1,
        title: `${marker} comment in ${rel}:${line}${note ? ` — ${note}` : ''}`,
        description:
          `Inline \`${marker}\` comment at \`${rel}:${line}\`. Tracking technical debt in source comments works for a sprint or two and then rots — these accumulate and nobody knows which ones are still relevant.`,
        evidence: [
          {
            file: rel,
            range: { startLine: line, endLine: line },
            snippet: snippetAround(lines, line),
          },
        ],
        suggestion:
          'Move actionable items to your issue tracker and link the ticket from the comment, or delete the comment if it has become obsolete. Repo-wide grep for stale markers is a useful periodic chore.',
        fingerprint: `todo-comments:${stableHash(`${rel}:${line}:${marker}:${note}`)}`,
      });
    }
  }
  return findings;
}

const DEFAULT_MARKERS = [
  'TODO',
  'FIXME',
  'HACK',
  'XXX',
  'BUG',
  'NOTE',
  'REVIEW',
  'WTF',
  'DEPRECATED',
  'DEPRECATE',
];

function severityFor(marker: string): 'high' | 'medium' | 'low' {
  switch (marker) {
    case 'HACK':
    case 'XXX':
    case 'WTF':
    case 'FIXME':
    case 'BUG':
      return 'medium';
    case 'TODO':
    case 'NOTE':
    case 'REVIEW':
    case 'DEPRECATED':
    case 'DEPRECATE':
    default:
      return 'low';
  }
}

/**
 * Recursive workspace walk that returns relative file paths matching
 * `isAnalysable`. Stops at conventional skip-dirs (node_modules, dist,
 * build, .git, …) so big legacy repos don't blow the file budget.
 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  // Path exclusions come from `.gitignore` + `.rothunterignore` only.
  // The matcher always bakes in `node_modules` + `.git` so a workspace
  // without ignore files still walks something sensible.
  const gitignore = loadGitignore(root);
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(root, rel) : root;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries) {
      const childRel = rel ? path.join(rel, name) : name;
      const posixRel = childRel.replace(/\\/g, '/');
      const childAbs = path.join(root, childRel);
      let s;
      try {
        s = statSync(childAbs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (gitignore.ignores(posixRel + '/')) continue;
        stack.push(childRel);
      } else if (s.isFile() && isAnalysable(childRel)) {
        if (gitignore.ignores(posixRel)) continue;
        out.push(posixRel);
      }
    }
  }
  return out;
}

function isAnalysable(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|sql|sh|yaml|yml|toml)$/.test(posix)
    && !/\.d\.ts$/.test(posix)
    && !/(^|\/)node_modules\//.test(posix)
    && !/(^|\/)dist\//.test(posix)
    && !/(^|\/)build\//.test(posix);
}

function snippetAround(lines: ReadonlyArray<string>, line: number): string {
  const from = Math.max(0, line - 2);
  const to = Math.min(lines.length, line + 1);
  return lines.slice(from, to).join('\n');
}


