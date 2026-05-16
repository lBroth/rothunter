import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';

// IaC entry-point walker. Picks up CDK / SST / serverless constructs:
// NodejsFunction, lambda.Function, sst.Function, sst.Api routes, bundle({...}).
// Reads `entry` / `handler` / `code` strings → workspace-relative paths.
export function resolveIacEntryFiles(
  workspaceRoot: string,
  files: ReadonlyArray<string>,
): Set<string> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  for (const rel of files) {
    project.addSourceFileAtPathIfExists(path.join(workspaceRoot, rel));
  }

  const out = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    walkFile(workspaceRoot, sf, out);
  }
  return out;
}

const ENTRY_PROPERTY_NAMES = new Set(['entry', 'handler', 'code', 'entrypoint']);

/**
 * Scan a single TypeScript source file for IaC construct entry strings.
 * Emits each resolved workspace-relative target into `accumulator`.
 */
function walkFile(workspaceRoot: string, sourceFile: SourceFile, accumulator: Set<string>): void {
  const sourceFileDir = path.dirname(sourceFile.getFilePath());

  // Walk every object-literal expression and inspect properties whose name is
  // a known IaC entry property. We don't try to scope this to NewExpression
  // ancestry — that adds complexity for little gain. False positives here
  // simply mean "this string was treated as an entry point" which is the safe
  // direction (entry points get *protected* by the dead-module detector).
  for (const obj of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    for (const prop of obj.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      // PropertyAssignment has .getName() and .getInitializer() on ts-morph wrapper.
      const pa = prop as { getName(): string; getInitializer(): unknown };
      const name = pa.getName();
      if (!ENTRY_PROPERTY_NAMES.has(name)) continue;
      const init = pa.getInitializer() as
        | { getKind(): number; getLiteralText(): string }
        | undefined;
      if (!init) continue;
      // Accept plain string literals and template literals with no interpolation.
      const k = init.getKind();
      if (k !== SyntaxKind.StringLiteral && k !== SyntaxKind.NoSubstitutionTemplateLiteral) continue;
      const raw = init.getLiteralText();

      // `handler: 'src/handlers/foo.handler'` — strip the trailing export name.
      // For AWS Lambda the convention is `<file>.<exportedFn>`; we want the
      // file, not the export.
      const filePart = raw.replace(/\.[A-Za-z_$][\w$]*$/, '');

      const resolved = resolveEntryString(workspaceRoot, sourceFileDir, filePart);
      if (resolved) accumulator.add(resolved);
    }
  }

  // SST / Serverless `routes: { 'GET /foo': 'src/routes/foo.handler' }` — pick
  // string values whose lexical position is a value in a routes-shaped object.
  for (const obj of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const parent = obj.getParent();
    const parentName = inferPropertyOwnerName(parent);
    if (parentName !== 'routes') continue;
    for (const prop of obj.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const pa = prop as { getInitializer(): unknown };
      const init = pa.getInitializer() as
        | { getKind(): number; getLiteralText(): string }
        | undefined;
      if (!init) continue;
      const k = init.getKind();
      if (k !== SyntaxKind.StringLiteral && k !== SyntaxKind.NoSubstitutionTemplateLiteral) continue;
      const raw = init.getLiteralText();
      const filePart = raw.replace(/\.[A-Za-z_$][\w$]*$/, '');
      const resolved = resolveEntryString(workspaceRoot, sourceFileDir, filePart);
      if (resolved) accumulator.add(resolved);
    }
  }
}

/** Walk up the parent chain looking for the PropertyAssignment that holds this object literal. */
function inferPropertyOwnerName(node: unknown): string | undefined {
  let cur = node as { getKind?: () => number; getParent?: () => unknown; getName?: () => string } | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.getKind && cur.getKind() === SyntaxKind.PropertyAssignment && cur.getName) {
      return cur.getName();
    }
    cur = cur.getParent ? (cur.getParent() as typeof cur) : undefined;
  }
  return undefined;
}

/**
 * Resolve a CDK/SST entry string to a workspace-relative file path. The
 * string is typically project-relative (`src/handlers/foo.ts`) but may be
 * relative to the file declaring the construct (`./foo.ts`).
 */
function resolveEntryString(workspaceRoot: string, sourceFileDir: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  const isRelative = trimmed.startsWith('.') || trimmed.startsWith('/');
  if (isRelative) {
    candidates.push(path.resolve(sourceFileDir, trimmed));
  }
  // Project-relative form is by far the most common in CDK projects.
  candidates.push(path.resolve(workspaceRoot, trimmed));
  candidates.push(path.resolve(workspaceRoot, 'src', trimmed));

  const extensions = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
  for (const base of candidates) {
    for (const ext of extensions) {
      const abs = `${base}${ext}`;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return path.relative(workspaceRoot, abs);
      }
    }
  }
  return null;
}
