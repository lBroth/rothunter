import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  Project,
  SyntaxKind,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type Node,
} from 'ts-morph';
import type { Finding } from '../types.js';
import { buildCfg, blockOf, reachable, type Cfg } from '../graph/cfg.js';

export interface RaceConditionDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
  /** Optional pre-built ts-morph Project — saves a parse per file. */
  project?: Project;
}

type AsyncCallable = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

interface ReadEntry {
  target: string; // canonical key e.g. `this.foo` or `cache`
  line: number;
  node: Node;
}

interface AwaitEntry {
  line: number;
  node: Node;
}

interface WriteEntry {
  target: string;
  line: number;
  endLine: number;
  source: string;
  node: Node;
}

interface RaceCandidate {
  file: string;
  target: string;
  readLine: number;
  awaitLine: number;
  writeLine: number;
  writeEndLine: number;
  writeSnippet: string;
  enclosingName?: string;
  enclosingSource: string;
}

// Tier-1 race detector. Three patterns:
//   1. read → await → write on `this.<id>` / module `let`/`var`
//   2. Promise.all/allSettled/race arms writing the same shared target
//   3. emitter.on/.addListener handler closing over outer mutable + read-modify-write across await
// Severity medium, confidence 0.7. `// rothunter:ignore-race` suppresses.
const PROMISE_PARALLEL_METHODS = new Set(['all', 'allSettled', 'race']);
const EMITTER_REGISTRATION_METHODS = new Set(['on', 'once', 'addListener', 'addEventListener']);

interface PromiseAllRace {
  file: string;
  callLine: number;
  callEndLine: number;
  target: string;
  writes: ReadonlyArray<{ line: number; snippet: string }>;
  enclosingSource: string;
  /** Outer named function/method that contains the Promise.all call, if any. */
  enclosingName?: string;
}

export function detectRaceConditions(input: RaceConditionDetectorInput): Finding[] {
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

  const rmwCandidates: RaceCandidate[] = [];
  const promiseAllRaces: PromiseAllRace[] = [];
  const findings: Finding[] = [];

  for (const sf of project.getSourceFiles()) {
    const relativeFile = path.relative(input.workspaceRoot, sf.getFilePath());
    const moduleMutables = collectModuleMutables(sf);

    // Pattern 1 — read-modify-write across await (every async callable).
    for (const fn of sf.getFunctions()) {
      rmwCandidates.push(...analyzeAsync(fn, relativeFile, moduleMutables));
    }
    for (const cls of sf.getClasses()) {
      for (const m of cls.getMethods()) {
        rmwCandidates.push(...analyzeAsync(m, relativeFile, moduleMutables));
      }
    }
    for (const arrow of sf.getDescendantsOfKind(SyntaxKind.ArrowFunction)) {
      rmwCandidates.push(...analyzeAsync(arrow, relativeFile, moduleMutables));
    }
    for (const expr of sf.getDescendantsOfKind(SyntaxKind.FunctionExpression)) {
      rmwCandidates.push(...analyzeAsync(expr, relativeFile, moduleMutables));
    }

    // Pattern 2 — Promise.all siblings writing the same target.
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const race = analyzePromiseAll(call, relativeFile, moduleMutables);
      if (race) promiseAllRaces.push(...race);
    }

    // Pattern 3 — event-emitter handler closing over an outer mutable.
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const handlerRaces = analyzeEmitterHandler(call, relativeFile);
      if (handlerRaces.length) rmwCandidates.push(...handlerRaces);
    }
  }

  // Pattern 1 + Pattern 3 share the same `analyzeAsync` engine: a handler that
  // closes over a module-scope `let` is independently picked up by both the
  // top-level arrow walker (anonymous arrow → no enclosingName) and the
  // emitter-handler walker (carries the outer named function on its
  // candidates). Sort so named candidates win the fingerprint dedup.
  rmwCandidates.sort((a, b) => (b.enclosingName ? 1 : 0) - (a.enclosingName ? 1 : 0));
  const seen = new Set<string>();
  for (const c of rmwCandidates) {
    const f = toFinding(c);
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    findings.push(f);
  }
  for (const r of promiseAllRaces) {
    const f = promiseAllToFinding(r);
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    findings.push(f);
  }
  return findings;
}

function collectModuleMutables(sf: { getVariableStatements(): unknown[] }): Set<string> {
  const out = new Set<string>();
  const statements = (sf as {
    getVariableStatements(): Array<{
      getDeclarationKind(): string;
      getDeclarations(): Array<{ getName(): string; getNameNode(): Node }>;
    }>;
  }).getVariableStatements();
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

function analyzeAsync(fn: AsyncCallable, file: string, moduleMutables: Set<string>): RaceCandidate[] {
  if (!(fn as { isAsync(): boolean }).isAsync()) return [];
  const body = (fn as { getBody?: () => Node | undefined }).getBody?.();
  if (!body) return [];

  const reads: ReadEntry[] = [];
  const awaits: AwaitEntry[] = [];
  const writes: WriteEntry[] = [];

  // --- Reads: variable initialisers that pull from shared state -------------
  for (const decl of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init) continue;
    const target = canonicalSharedTarget(init, moduleMutables);
    if (!target) continue;
    reads.push({ target, line: decl.getStartLineNumber(), node: decl });
  }
  // Also: `const { x } = this`-style destructuring — treat as a read of `this`.
  // For now we only emit if the destructured source itself is a shared target
  // expression that maps to a canonical key (skipping deep-destructure for v0.1).

  // --- Awaits ---------------------------------------------------------------
  for (const aw of body.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    awaits.push({ line: aw.getStartLineNumber(), node: aw });
  }
  if (awaits.length === 0) return [];

  // --- Writes: assignment expressions whose LHS is shared state -------------
  for (const bin of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getText() !== '=') continue;
    if (hasIgnoreAnnotation(bin)) continue;
    const target = canonicalSharedTarget(bin.getLeft(), moduleMutables);
    if (!target) continue;
    writes.push({
      target,
      line: bin.getStartLineNumber(),
      endLine: bin.getEndLineNumber(),
      source: bin.getText(),
      node: bin,
    });
  }
  if (writes.length === 0) return [];

  const enclosingName = (fn as { getName?: () => string | undefined }).getName?.();
  const enclosingSource = trimEnclosingSource((fn as { getText(): string }).getText());

  // Build a CFG of the function body and use forward reachability to
  // confirm that some execution path actually visits read → await → write
  // in that order. Pure line-number ordering misfires on
  //   `if (cond) { read } await x; write` — `read` is conditional and may
  // never execute on the path that reaches the write. The CFG resolves
  // that ambiguity (the if-then block and the post-if join block are
  // different CFG nodes, so the read is NOT reachable from the join
  // entry without going through the then branch).
  const cfg = buildCfg(body);
  const blockCache = new Map<Node, number>();
  const blockFor = (n: Node): number => {
    const cached = blockCache.get(n);
    if (cached !== undefined) return cached;
    const id = blockOf(cfg, n);
    blockCache.set(n, id);
    return id;
  };
  const orderedReach = (
    fromBlock: number,
    fromLine: number,
    toBlock: number,
    toLine: number,
  ): boolean => {
    if (fromBlock < 0 || toBlock < 0) return false;
    if (fromBlock === toBlock) {
      // Same straight-line block — strict line ordering. Back-edges that
      // loop the block to itself are picked up by reachable() below; the
      // first-iteration ordering is what matters for the standard
      // read-modify-write pattern.
      return fromLine < toLine || reachable(cfg, fromBlock, toBlock);
    }
    return reachable(cfg, fromBlock, toBlock);
  };

  const out: RaceCandidate[] = [];
  for (const r of reads) {
    const rBlock = blockFor(r.node);
    if (rBlock < 0) continue;
    let chosen: { aw: AwaitEntry; w: WriteEntry } | null = null;
    for (const aw of awaits) {
      const aBlock = blockFor(aw.node);
      if (!orderedReach(rBlock, r.line, aBlock, aw.line)) continue;
      for (const w of writes) {
        if (w.target !== r.target) continue;
        const wBlock = blockFor(w.node);
        if (!orderedReach(aBlock, aw.line, wBlock, w.line)) continue;
        chosen = { aw, w };
        break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    out.push({
      file,
      target: r.target,
      readLine: r.line,
      awaitLine: chosen.aw.line,
      writeLine: chosen.w.line,
      writeEndLine: chosen.w.endLine,
      writeSnippet: trimSnippet(chosen.w.source),
      enclosingName: enclosingName ?? undefined,
      enclosingSource,
    });
  }
  return out;
}

// Pattern 2: Promise.all/allSettled/race. Two shapes:
//   (a) array-literal arms writing same target → cluster finding
//   (b) .map(async ...) parallel callback with read→await→write → single finding
function analyzePromiseAll(
  call: import('ts-morph').CallExpression,
  file: string,
  moduleMutables: Set<string>,
): PromiseAllRace[] {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return [];
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const head = pa.getExpression().getText();
  if (head !== 'Promise') return [];
  if (!PROMISE_PARALLEL_METHODS.has(pa.getName())) return [];

  const [arg] = call.getArguments();
  if (!arg) return [];

  // (b) `.map(async ...)` parallel-callback shape.
  if (arg.getKind() === SyntaxKind.CallExpression) {
    return analyzeParallelMapCallback(call, arg, file, moduleMutables);
  }

  // (a) array-literal arms.
  const arrayArg = arg.asKind(SyntaxKind.ArrayLiteralExpression);
  if (!arrayArg) return [];
  const elements = arrayArg.getElements();
  if (elements.length < 2) return [];

  // For each arm, collect the function body (arrow / function-expression /
  // IIFE wrapping one of those).
  type ArmWrite = { armIndex: number; target: string; line: number; snippet: string };
  const armWrites: ArmWrite[] = [];

  for (let i = 0; i < elements.length; i++) {
    const armBody = resolveFunctionBody(elements[i]!);
    if (!armBody) continue;
    for (const bin of armBody.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (bin.getOperatorToken().getText() !== '=') continue;
      if (hasIgnoreAnnotation(bin)) continue;
      const target = canonicalSharedTarget(bin.getLeft(), moduleMutables);
      if (!target) continue;
      armWrites.push({
        armIndex: i,
        target,
        line: bin.getStartLineNumber(),
        snippet: trimSnippet(bin.getText()),
      });
    }
  }

  // Cluster by target — only emit when ≥ 2 distinct arms write.
  const byTarget = new Map<string, ArmWrite[]>();
  for (const w of armWrites) {
    const list = byTarget.get(w.target) ?? [];
    list.push(w);
    byTarget.set(w.target, list);
  }

  const enclosingFn = findEnclosingNamedFunction(call);
  const enclosingSource = enclosingFn
    ? trimEnclosingSource((enclosingFn as { getText(): string }).getText())
    : trimEnclosingSource(call.getText());
  const enclosingName = enclosingFn
    ? (enclosingFn as { getName?: () => string | undefined }).getName?.()
    : undefined;

  const out: PromiseAllRace[] = [];
  for (const [target, list] of byTarget) {
    const armIndices = new Set(list.map((w) => w.armIndex));
    if (armIndices.size < 2) continue;
    out.push({
      file,
      callLine: call.getStartLineNumber(),
      callEndLine: call.getEndLineNumber(),
      target,
      writes: list.map((w) => ({ line: w.line, snippet: w.snippet })),
      enclosingSource,
      enclosingName: enclosingName ?? undefined,
    });
  }
  return out;
}

/**
 * `Promise.all(<arr>.map(async (x) => { ... }))` — single async callback
 * invoked once per element with full parallelism. Every read-modify-write
 * across `await` on a shared target races with every other invocation.
 */
function analyzeParallelMapCallback(
  promiseCall: import('ts-morph').CallExpression,
  arg: Node,
  file: string,
  moduleMutables: Set<string>,
): PromiseAllRace[] {
  // arg must be a `.map(<fn>)` / `.forEach(<fn>)` call. `.forEach` does NOT
  // surface its returned promises so it cannot create races through
  // Promise.all — only `.map` counts here.
  if (arg.getKind() !== SyntaxKind.CallExpression) return [];
  const mapCall = arg as import('ts-morph').CallExpression;
  const mapCallee = mapCall.getExpression();
  if (mapCallee.getKind() !== SyntaxKind.PropertyAccessExpression) return [];
  const mapPa = mapCallee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  if (mapPa.getName() !== 'map') return [];

  const [cb] = mapCall.getArguments();
  if (!cb) return [];
  if (
    cb.getKind() !== SyntaxKind.ArrowFunction &&
    cb.getKind() !== SyntaxKind.FunctionExpression
  ) {
    return [];
  }
  const fn = cb as ArrowFunction | FunctionExpression;
  // Only async callbacks can host the read-modify-write-across-await pattern.
  if (!(fn as { isAsync?: () => boolean }).isAsync?.()) return [];
  const body = (fn as { getBody?: () => Node | undefined }).getBody?.();
  if (!body) return [];

  // Collect shared-target writes that follow an `await`.
  const awaits = body.getDescendantsOfKind(SyntaxKind.AwaitExpression).map((a) => a.getStartLineNumber());
  if (awaits.length === 0) return [];
  const firstAwait = Math.min(...awaits);

  const enclosingFn = findEnclosingNamedFunction(promiseCall);
  const enclosingSource = enclosingFn
    ? trimEnclosingSource((enclosingFn as { getText(): string }).getText())
    : trimEnclosingSource(promiseCall.getText());
  const enclosingName = enclosingFn
    ? (enclosingFn as { getName?: () => string | undefined }).getName?.()
    : undefined;

  const writesByTarget = new Map<string, Array<{ line: number; snippet: string }>>();
  for (const bin of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getText() !== '=') continue;
    if (hasIgnoreAnnotation(bin)) continue;
    if (bin.getStartLineNumber() < firstAwait) continue;
    const target = canonicalSharedTarget(bin.getLeft(), moduleMutables);
    if (!target) continue;
    const list = writesByTarget.get(target) ?? [];
    list.push({ line: bin.getStartLineNumber(), snippet: trimSnippet(bin.getText()) });
    writesByTarget.set(target, list);
  }

  const out: PromiseAllRace[] = [];
  for (const [target, writes] of writesByTarget) {
    out.push({
      file,
      callLine: promiseCall.getStartLineNumber(),
      callEndLine: promiseCall.getEndLineNumber(),
      target,
      writes,
      enclosingSource,
      enclosingName: enclosingName ?? undefined,
    });
  }
  return out;
}

function resolveFunctionBody(node: Node): Node | null {
  let cur: Node = node;
  // Unwrap parens + IIFEs to land on the arrow/function-expression body.
  for (let i = 0; i < 6; i++) {
    const paren = cur.asKind(SyntaxKind.ParenthesizedExpression);
    if (paren) {
      cur = paren.getExpression();
      continue;
    }
    const callShape = cur.asKind(SyntaxKind.CallExpression);
    if (callShape) {
      let inner: Node = callShape.getExpression();
      let innerParen = inner.asKind(SyntaxKind.ParenthesizedExpression);
      while (innerParen) {
        inner = innerParen.getExpression();
        innerParen = inner.asKind(SyntaxKind.ParenthesizedExpression);
      }
      if (
        inner.getKind() === SyntaxKind.ArrowFunction ||
        inner.getKind() === SyntaxKind.FunctionExpression
      ) {
        cur = inner;
        continue;
      }
      return null;
    }
    break;
  }
  if (
    cur.getKind() === SyntaxKind.ArrowFunction ||
    cur.getKind() === SyntaxKind.FunctionExpression
  ) {
    return (cur as { getBody?: () => Node | undefined }).getBody?.() ?? null;
  }
  return null;
}

/**
 * Walk ancestors until a named function-like is hit. Useful for surfacing
 * the outer named function on findings whose immediate enclosing scope is
 * an anonymous arrow/IIFE (Promise.all arms, emitter handlers). Falls back
 * to the nearest function-like when no named ancestor exists.
 */
function findEnclosingNamedFunction(node: Node): Node | null {
  let nearest: Node | null = null;
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const k = cur.getKind();
    if (
      k === SyntaxKind.FunctionDeclaration ||
      k === SyntaxKind.MethodDeclaration ||
      k === SyntaxKind.ArrowFunction ||
      k === SyntaxKind.FunctionExpression
    ) {
      if (!nearest) nearest = cur;
      const name = (cur as { getName?: () => string | undefined }).getName?.();
      if (name) return cur;
    }
    cur = cur.getParent();
  }
  return nearest;
}

/**
 * Pattern 3 — `emitter.on(event, handler)` where the handler closes over
 * an outer `let`/`var` and performs a read-modify-write across `await`.
 *
 * We treat any `let`/`var` declared in an enclosing scope (function body,
 * module top level) as a shared mutable. The same `analyzeAsync` engine
 * then runs on the handler body — emitting the canonical read-modify-write
 * race-condition finding.
 */
function analyzeEmitterHandler(
  call: import('ts-morph').CallExpression,
  file: string,
): RaceCandidate[] {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return [];
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  if (!EMITTER_REGISTRATION_METHODS.has(pa.getName())) return [];

  const args = call.getArguments();
  if (args.length < 2) return [];
  const handler = args[args.length - 1]!;
  if (
    handler.getKind() !== SyntaxKind.ArrowFunction &&
    handler.getKind() !== SyntaxKind.FunctionExpression
  ) {
    return [];
  }
  const fn = handler as ArrowFunction | FunctionExpression;
  // Only async handlers can hit a read-modify-write race across `await`.
  if (!(fn as { isAsync?: () => boolean }).isAsync?.()) return [];

  const outerMutables = collectOuterMutables(call, fn);
  if (outerMutables.size === 0) return [];

  const candidates = analyzeAsync(fn, file, outerMutables);
  // The handler itself is anonymous (arrow / function expression). Surface
  // the outer named function that registered the listener so the finding
  // has a useful enclosingName for downstream callers.
  const outerNamed = findEnclosingNamedFunction(call);
  const outerName = outerNamed
    ? (outerNamed as { getName?: () => string | undefined }).getName?.()
    : undefined;
  if (outerName) {
    for (const c of candidates) {
      if (!c.enclosingName) c.enclosingName = outerName;
    }
  }
  return candidates;
}

// let/var bindings the handler closes over. const skipped — mutable
// contents (Map/Set/Array) are tracked via member writes elsewhere.
function collectOuterMutables(call: Node, handler: Node): Set<string> {
  const out = new Set<string>();
  let cur: Node | undefined = call.getParent();
  while (cur) {
    if (
      cur.getKind() === SyntaxKind.Block ||
      cur.getKind() === SyntaxKind.SourceFile
    ) {
      const stmts = (cur as { getVariableStatements?: () => unknown[] }).getVariableStatements?.();
      if (Array.isArray(stmts)) {
        for (const stmt of stmts as Array<{
          getDeclarationKind(): string;
          getDeclarations(): Array<{ getName(): string; getNameNode(): Node }>;
        }>) {
          const kind = stmt.getDeclarationKind();
          if (kind !== 'let' && kind !== 'var') continue;
          for (const decl of stmt.getDeclarations()) {
            if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
            out.add(decl.getName());
          }
        }
      }
    }
    if (cur === handler) break;
    cur = cur.getParent();
  }
  return out;
}

// Canonical key for shared state. this.foo[.bar] → "this.foo"; bare/elem-access
// → identifier only if it's a known module mutable. null otherwise.
function canonicalSharedTarget(expr: Node, moduleMutables: Set<string>): string | null {
  let cur: Node = expr;
  // For PropertyAccessExpression chains, descend to the head identifier or `this`.
  while (true) {
    const propAccess = cur.asKind(SyntaxKind.PropertyAccessExpression);
    const elemAccess = cur.asKind(SyntaxKind.ElementAccessExpression);
    if (!propAccess && !elemAccess) break;
    const owner: Node = (propAccess ?? elemAccess!).getExpression();
    if (propAccess && owner.getKind() === SyntaxKind.ThisKeyword) {
      // `this.<name>` — canonical key.
      return `this.${propAccess.getName()}`;
    }
    cur = owner;
  }
  if (cur.getKind() === SyntaxKind.Identifier) {
    const name = cur.getText();
    if (moduleMutables.has(name)) return name;
  }
  return null;
}

const IGNORE_ANNOTATION = 'rothunter:ignore-race';

function hasIgnoreAnnotation(node: Node): boolean {
  for (const range of node.getLeadingCommentRanges()) {
    if (range.getText().includes(IGNORE_ANNOTATION)) return true;
  }
  const fullStart = node.getFullStart();
  const sf = node.getSourceFile();
  const text = sf.getFullText().slice(Math.max(0, fullStart - 200), fullStart);
  return text.includes(IGNORE_ANNOTATION);
}

function trimSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 140 ? collapsed.slice(0, 137) + '...' : collapsed;
}

function trimEnclosingSource(full: string): string {
  const lines = full.split(/\r?\n/);
  if (lines.length <= 42) return full;
  return [...lines.slice(0, 40), '  // ...', lines[lines.length - 1] ?? ''].join('\n');
}

function toFinding(c: RaceCandidate): Finding {
  const title = `Read-modify-write across \`await\` on ${c.target}`;
  const description = [
    `${title}.`,
    `Two concurrent callers can both read \`${c.target}\` before either writes back. The second write overrides the first.`,
    `Locations:`,
    `- ${c.file}:${c.readLine} (read \`${c.target}\`)`,
    `- ${c.file}:${c.awaitLine} (await yields control)`,
    `- ${c.file}:${c.writeLine} (write \`${c.writeSnippet}\`)`,
    '',
    `If the function is invoked behind a mutex / queue / single-flight wrapper, OR the state is per-request and not shared between callers, add a \`// rothunter:ignore-race\` comment above the write OR document the synchronisation.`,
  ].join('\n');

  return {
    detectorId: 'race-condition',
    severity: 'medium',
    confidence: 0.7,
    layer: 1,
    title,
    description,
    evidence: [
      {
        file: c.file,
        range: { startLine: c.readLine, endLine: c.writeEndLine },
        snippet: c.enclosingSource,
        note: JSON.stringify({
          target: c.target,
          readLine: c.readLine,
          awaitLine: c.awaitLine,
          writeLine: c.writeLine,
          enclosingName: c.enclosingName ?? '',
        }),
      },
    ],
    suggestion:
      'Wrap the critical section in a mutex / single-flight / queue, OR fetch + update + write in one atomic transaction, OR re-fetch the value just before the write.',
    fingerprint: `race:read-modify-write:${stableHash(`${c.file}::${c.target}::${c.readLine}::${c.writeLine}`)}`,
  };
}

function promiseAllToFinding(r: PromiseAllRace): Finding {
  const title = `Parallel \`Promise.all\` arms write the same shared target ${r.target}`;
  const description = [
    `${title}.`,
    `Two or more sibling arms of the \`Promise.all\` (or \`Promise.allSettled\` / \`Promise.race\`) call write \`${r.target}\`. When both arms execute concurrently the second write overrides the first — guaranteed lost-update, no timing window required.`,
    `Locations:`,
    `- ${r.file}:${r.callLine} (parallel call)`,
    ...r.writes.map((w) => `- ${r.file}:${w.line} (write \`${w.snippet}\`)`),
    '',
    'If the arms must run in parallel, write to per-arm locals and merge afterwards, OR serialise the parallel arms, OR use an atomic counter (e.g. mutex / single-flight). Annotate with `// rothunter:ignore-race` on a write line if the parallel writes are mathematically commutative (e.g. set union with no read).',
  ].join('\n');

  return {
    detectorId: 'race-condition',
    severity: 'medium',
    confidence: 0.75,
    layer: 1,
    title,
    description,
    evidence: [
      {
        file: r.file,
        range: { startLine: r.callLine, endLine: r.callEndLine },
        snippet: r.enclosingSource,
        note: JSON.stringify({
          pattern: 'promise-all',
          target: r.target,
          callLine: r.callLine,
          writeLines: r.writes.map((w) => w.line),
          enclosingName: r.enclosingName ?? '',
        }),
      },
    ],
    suggestion:
      'Move the mutating writes out of parallel arms (compute into local results, merge after `await Promise.all`), OR serialise the writes through a single arm, OR wrap with a mutex / atomic primitive.',
    fingerprint: `race:promise-all:${stableHash(`${r.file}::${r.target}::${r.callLine}`)}`,
  };
}

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
