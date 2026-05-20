import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Project } from 'ts-morph';

/**
 * Build a fast workspace-relative source reader. File-walking detectors
 * (magic-numbers, console-log-prod, silent-catch, skip-tests, bad-config,
 * long-file, mutable-globals, …) used to readFileSync every
 * candidate file independently — the orchestrator already parsed those
 * same files into a shared ts-morph Project, so the disk I/O was pure
 * duplication. When a Project is passed, this reader serves text from
 * ts-morph's in-memory SourceFile cache; otherwise it falls back to
 * direct readFileSync so detectors keep working in their own tests
 * (where there is no shared Project to inject).
 *
 * Returns `null` on read failure (missing file, encoding error, etc.) —
 * callers should `continue` past missing files, same as the previous
 * readFileSync/try-catch shape.
 */
export type SourceReader = (rel: string) => string | null;

export function makeSourceReader(workspaceRoot: string, project?: Project): SourceReader {
  if (project) {
    const byRel = new Map<string, string>();
    for (const sf of project.getSourceFiles()) {
      const rel = path.relative(workspaceRoot, sf.getFilePath());
      // Use POSIX separator so reads work the same across platforms.
      byRel.set(rel.split(path.sep).join('/'), sf.getFullText());
    }
    return (rel) => byRel.get(rel.split(path.sep).join('/')) ?? readFromDisk(workspaceRoot, rel);
  }
  return (rel) => readFromDisk(workspaceRoot, rel);
}

function readFromDisk(workspaceRoot: string, rel: string): string | null {
  try {
    return readFileSync(path.resolve(workspaceRoot, rel), 'utf-8');
  } catch {
    return null;
  }
}
