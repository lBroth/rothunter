import * as path from 'node:path';
import { stableHash } from '../utils/hash.js';
import { trimSnippet, trimEnclosingSource } from '../utils/snippet.js';
import {
  Project,
  SyntaxKind,
  type FunctionDeclaration,
  type MethodDeclaration,
  type Node,
  type ArrowFunction,
  type FunctionExpression,
} from 'ts-morph';
import type { Finding, Severity } from '../types.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface MutationDetectorInput extends FileWalkingDetectorInput {}

type MutationPattern =
  | 'array-mutator'
  | 'object-assign'
  | 'delete-property'
  | 'property-assignment'
  | 'shared-state-write';

interface RawCandidate {
  file: string;
  line: number;
  endLine: number;
  pattern: MutationPattern;
  /** Whether the mutated value is bound to a parameter (Tier 1) or module-scope mutable (Tier 2). */
  scope: 'parameter' | 'module-state';
  /** True when the mutated parameter is also returned / assigned to this.x / passed to a callback. */
  escapes: boolean;
  target: string;
  method?: string;
  snippet: string;
  source: string;
  /** Surrounding function/method source — used by the LLM confirmer. */
  enclosingSource: string;
  /** Function or method name, when known — used by the LLM confirmer. */
  enclosingName?: string;
}

const MUTATING_ARRAY_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);

const ASSIGNMENT_OPERATORS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
]);

const IGNORE_ANNOTATION = 'rothunter:ignore-mutation';

// Parameter-mutation detector. Flags array-mutators, Object.assign target,
// delete, property assignment on params NOT typed Readonly/ReadonlyArray.
// `this.x = y` + constructor self-init skipped. `// rothunter:ignore-mutation`
// suppresses.
export function detectMutations(input: MutationDetectorInput): Finding[] {
  let project: Project;
  if (input.project) {
    project = input.project;
  } else {
    project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    for (const rel of input.files) {
      project.addSourceFileAtPathIfExists(path.join(input.workspaceRoot, rel));
    }
  }

  const candidates: RawCandidate[] = [];
  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const relativeFile = path.relative(input.workspaceRoot, filePath);

    // Tier 2 — module-scope mutable identifiers (`let`/`var` at top level).
    // Their mutations from any function body are treated as shared-state writes.
    const moduleMutables = collectModuleMutables(sf);

    for (const fn of sf.getFunctions()) {
      candidates.push(...analyzeCallable(fn, relativeFile, moduleMutables));
    }
    for (const cls of sf.getClasses()) {
      for (const m of cls.getMethods())
        candidates.push(...analyzeCallable(m, relativeFile, moduleMutables));
    }
    for (const arrow of sf.getDescendantsOfKind(SyntaxKind.ArrowFunction)) {
      candidates.push(...analyzeCallable(arrow, relativeFile, moduleMutables));
    }
    for (const expr of sf.getDescendantsOfKind(SyntaxKind.FunctionExpression)) {
      candidates.push(...analyzeCallable(expr, relativeFile, moduleMutables));
    }
  }

  return candidates.map(toFinding);
}

/**
 * Top-level `let` / `var` declarations are the canonical "shared mutable
 * state" pattern. We deliberately exclude `const` because re-binding is
 * blocked there — `const arr = []; arr.push()` still mutates contents, but
 * the user has at least flagged the binding as fixed. For Tier 2 MVP we
 * focus on `let`/`var`, which signal "intentionally mutable" most loudly.
 */
function collectModuleMutables(sf: { getVariableStatements(): unknown[] }): Set<string> {
  const out = new Set<string>();
  const statements = (
    sf as {
      getVariableStatements(): Array<{
        getDeclarationKind(): string;
        getDeclarations(): Array<{ getName(): string; getNameNode(): Node }>;
      }>;
    }
  ).getVariableStatements();
  for (const stmt of statements) {
    const kind = stmt.getDeclarationKind();
    if (kind !== 'let' && kind !== 'var') continue;
    for (const decl of stmt.getDeclarations()) {
      if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
      out.add(decl.getName());
    }
  }
  return out;
}

type Callable = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

function analyzeCallable(fn: Callable, file: string, moduleMutables: Set<string>): RawCandidate[] {
  const params = new Map<string, { typeText: string }>();
  for (const p of fn.getParameters()) {
    // Destructured params (`{a, b}: User`) — skip; mutation of `a`/`b` is
    // mutation of locals, not the original argument.
    if (p.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
    const name = p.getName();
    const typeNode = p.getTypeNode();
    const typeText = typeNode ? typeNode.getText() : p.getType().getText();
    params.set(name, { typeText });
  }

  const body = (fn as { getBody?: () => Node | undefined }).getBody?.();
  if (!body) return [];

  const enclosingSource = trimEnclosingSource((fn as { getText(): string }).getText());
  const enclosingName = (fn as { getName?: () => string | undefined }).getName?.();

  // Pre-compute escape signals once per function: what identifiers leave the
  // function via return / this.x assignment / call argument? Used to bump
  // severity of param mutations that touch escaping bindings.
  const escapingIdentifiers = collectEscapingIdentifiers(body);

  const found: RawCandidate[] = [];

  const resolveScope = (
    name: string,
  ): { scope: 'parameter' | 'module-state'; readonly: boolean } | null => {
    const param = params.get(name);
    if (param) return { scope: 'parameter', readonly: isReadonlyType(param.typeText) };
    if (moduleMutables.has(name)) return { scope: 'module-state', readonly: false };
    return null;
  };

  // --- Array mutator and Object.assign call expressions -----------------------
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (hasIgnoreAnnotation(call)) continue;
    const callee = call.getExpression();

    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const head = pa.getExpression().getText();
    const member = pa.getName();

    // Object.assign(target, ...) — flag when target is a parameter or module mutable.
    if (head === 'Object' && member === 'assign') {
      const [first] = call.getArguments();
      if (!first || first.getKind() !== SyntaxKind.Identifier) continue;
      const targetName = first.getText();
      const scope = resolveScope(targetName);
      if (!scope || scope.readonly) continue;
      found.push({
        file,
        line: call.getStartLineNumber(),
        endLine: call.getEndLineNumber(),
        pattern: scope.scope === 'module-state' ? 'shared-state-write' : 'object-assign',
        scope: scope.scope,
        escapes: scope.scope === 'parameter' && escapingIdentifiers.has(targetName),
        target: targetName,
        snippet: trimSnippet(call.getText()),
        source: call.getText(),
        enclosingSource,
        enclosingName,
      });
      continue;
    }

    // Array mutator: identifier.push/...
    if (MUTATING_ARRAY_METHODS.has(member)) {
      const scope = resolveScope(head);
      if (!scope || scope.readonly) continue;
      found.push({
        file,
        line: call.getStartLineNumber(),
        endLine: call.getEndLineNumber(),
        pattern: scope.scope === 'module-state' ? 'shared-state-write' : 'array-mutator',
        scope: scope.scope,
        escapes: scope.scope === 'parameter' && escapingIdentifiers.has(head),
        target: head,
        method: member,
        snippet: trimSnippet(call.getText()),
        source: call.getText(),
        enclosingSource,
        enclosingName,
      });
    }
  }

  // --- delete <expr> ----------------------------------------------------------
  for (const del of body.getDescendantsOfKind(SyntaxKind.DeleteExpression)) {
    if (hasIgnoreAnnotation(del)) continue;
    const operand = del.getExpression();
    const root = identifierRoot(operand);
    if (!root) continue;
    const scope = resolveScope(root);
    if (!scope || scope.readonly) continue;
    found.push({
      file,
      line: del.getStartLineNumber(),
      endLine: del.getEndLineNumber(),
      pattern: scope.scope === 'module-state' ? 'shared-state-write' : 'delete-property',
      scope: scope.scope,
      escapes: scope.scope === 'parameter' && escapingIdentifiers.has(root),
      target: root,
      snippet: trimSnippet(del.getText()),
      source: del.getText(),
      enclosingSource,
      enclosingName,
    });
  }

  // --- <param>.x = y / += y / ... ---------------------------------------------
  for (const bin of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const opText = bin.getOperatorToken().getText();
    if (!ASSIGNMENT_OPERATORS.has(opText)) continue;
    if (hasIgnoreAnnotation(bin)) continue;
    const lhs = bin.getLeft();
    if (
      lhs.getKind() !== SyntaxKind.PropertyAccessExpression &&
      lhs.getKind() !== SyntaxKind.ElementAccessExpression
    ) {
      continue;
    }
    const root = identifierRoot(lhs);
    if (!root) continue;
    if (root === 'this') continue; // class method self-init — almost always intentional
    const scope = resolveScope(root);
    if (!scope || scope.readonly) continue;
    found.push({
      file,
      line: bin.getStartLineNumber(),
      endLine: bin.getEndLineNumber(),
      pattern: scope.scope === 'module-state' ? 'shared-state-write' : 'property-assignment',
      scope: scope.scope,
      escapes: scope.scope === 'parameter' && escapingIdentifiers.has(root),
      target: root,
      snippet: trimSnippet(bin.getText()),
      source: bin.getText(),
      enclosingSource,
      enclosingName,
    });
  }

  return found;
}

/**
 * Collect identifier names that LEAVE the function via a return value,
 * via `this.x = ident`, or by being passed as an argument to another call.
 *
 * Used to bump severity of param mutations: if a mutated param also escapes,
 * the mutation is more dangerous (the caller's state is now corrupted).
 *
 * Heuristic — we don't follow `const copy = arg; return copy;` (that needs
 * data-flow analysis). Direct uses only.
 */
function collectEscapingIdentifiers(body: Node): Set<string> {
  const out = new Set<string>();
  for (const ret of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expr = ret.getExpression();
    if (!expr) continue;
    collectIdentifiers(expr, out);
  }
  for (const bin of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getText() !== '=') continue;
    const lhs = bin.getLeft().asKind(SyntaxKind.PropertyAccessExpression);
    if (!lhs) continue;
    if (lhs.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue;
    collectIdentifiers(bin.getRight(), out);
  }
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // Skip the calls we already flag ourselves (Object.assign / array mutators)
    // to avoid counting the mutator's first argument as "escaping".
    for (const arg of call.getArguments()) {
      collectIdentifiers(arg as Node, out);
    }
  }
  return out;
}

function collectIdentifiers(node: Node, into: Set<string>): void {
  if (node.getKind() === SyntaxKind.Identifier) {
    into.add(node.getText());
    return;
  }
  for (const child of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
    into.add(child.getText());
  }
}

/** Walk a PropertyAccess / ElementAccess chain to the leftmost identifier. */
function identifierRoot(node: Node): string | null {
  let cur: Node = node;
  while (true) {
    const prop = cur.asKind(SyntaxKind.PropertyAccessExpression);
    const elem = cur.asKind(SyntaxKind.ElementAccessExpression);
    if (!prop && !elem) break;
    cur = (prop ?? elem!).getExpression();
  }
  if (cur.getKind() === SyntaxKind.Identifier) return cur.getText();
  if (cur.getKind() === SyntaxKind.ThisKeyword) return 'this';
  return null;
}

function isReadonlyType(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (/^Readonly<.*>$/.test(compact)) return true;
  if (/^ReadonlyArray<.*>$/.test(compact)) return true;
  if (/^readonly\s/.test(compact)) return true;
  if (/^readonly\s+[A-Za-z_$][\w$]*\[\]$/.test(compact)) return true;
  if (/^\(\s*readonly\s/.test(compact)) return true;
  return false;
}

function hasIgnoreAnnotation(node: Node): boolean {
  const trivia = node.getLeadingCommentRanges();
  for (const range of trivia) {
    if (range.getText().includes(IGNORE_ANNOTATION)) return true;
  }
  // Check trailing or preceding statement-level comment.
  const fullStart = node.getFullStart();
  const sf = node.getSourceFile();
  const text = sf.getFullText().slice(Math.max(0, fullStart - 200), fullStart);
  return text.includes(IGNORE_ANNOTATION);
}

function toFinding(c: RawCandidate): Finding {
  // Severity matrix (per ROADMAP):
  //   mutate-and-escape > mutate-shared-module > mutate-local
  const severity: Severity = c.escapes
    ? 'high'
    : c.scope === 'module-state'
      ? 'high'
      : c.pattern === 'delete-property'
        ? 'high'
        : 'medium';

  const subject = c.scope === 'module-state' ? 'Shared module state' : 'Parameter';
  const action =
    c.pattern === 'array-mutator'
      ? `array mutation: ${c.target}.${c.method ?? '?'}()`
      : c.pattern === 'object-assign'
        ? `mutation via Object.assign: ${c.target}`
        : c.pattern === 'delete-property'
          ? `property deletion: delete ${c.target}.…`
          : c.pattern === 'property-assignment'
            ? `property assignment: ${c.target}.…`
            : `write: ${c.target}`;
  const escapeTag = c.escapes ? ' [ESCAPES]' : '';
  const title = `${subject} ${action}${escapeTag}`;

  const description = [
    `${title} (pattern \`${c.pattern}\`, scope \`${c.scope}\`${c.escapes ? ', escapes' : ''}).`,
    `Locations:`,
    `- ${c.file}:${c.line} \`${c.snippet}\``,
    '',
    c.escapes
      ? 'The mutated value also escapes this function (returned, assigned to `this.x`, or passed onward). Callers will observe the mutation, which is the most damaging shape of this pattern.'
      : c.scope === 'module-state'
        ? 'This writes to a module-scope `let`/`var` binding. Any other function that imports or closes over the binding sees the change — surface-area for accidental shared state.'
        : "If the mutation is part of this function's contract (builder pattern, in-place transform), add a `// rothunter:ignore-mutation` comment above the call OR tighten the parameter type to `Readonly<...>` to document intent.",
  ].join('\n');

  return {
    detectorId: 'mutation',
    severity,
    confidence: c.escapes ? 0.82 : c.scope === 'module-state' ? 0.78 : 0.7,
    layer: 1,
    title,
    description,
    evidence: [
      {
        file: c.file,
        range: { startLine: c.line, endLine: c.endLine },
        snippet: c.source,
        // `note` carries the enclosing-function source for the LLM
        // confirmer. The markdown reporter intentionally does not render it.
        note: JSON.stringify({
          enclosingSource: c.enclosingSource,
          enclosingName: c.enclosingName ?? '',
          pattern: c.pattern,
          escapes: c.escapes,
        }),
      },
    ],
    suggestion:
      c.scope === 'module-state'
        ? 'Move the state into a module-scope `const` (with internal mutation hidden behind a small API) or into a class so the surface area is explicit.'
        : 'Return a new value instead of mutating the parameter, or type the parameter as Readonly<...>.',
    fingerprint: `mutation:${c.pattern}:${stableHash(`${c.file}::${c.line}::${c.target}`)}`,
  };
}

/**
 * Compress the enclosing function source so the LLM prompt stays in budget.
 * We keep the full signature line plus up to ~40 lines of body — enough to
 * judge intent without paying for the model to read a 200-line method.
 */
