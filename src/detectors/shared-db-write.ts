import * as path from 'node:path';
import { stableHash } from '../utils/hash.js';
import { trimSnippet, trimEnclosingSource } from '../utils/snippet.js';
import {
  Project,
  SyntaxKind,
  type CallExpression,
  type Node,
  type PropertyAccessExpression,
} from 'ts-morph';
import type { Finding } from '../types.js';
import type { FileWalkingDetectorInput } from '../types/detector-input.js';

export interface SharedDbWriteDetectorInput extends FileWalkingDetectorInput {}

interface WriteCall {
  /** Lowercased entity / table / collection name. */
  entity: string;
  /** Column / field name being written. */
  column: string;
  /** Which adapter (Prisma / Sequelize / …) matched this call — surfaced in the finding. */
  adapter: string;
  file: string;
  line: number;
  endLine: number;
  snippet: string;
  enclosingName?: string;
  enclosingSource: string;
}

// Cross-flow DB write detector. Indexes (entity, column) tuples for ORM /
// SQL-builder writes (Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle,
// raw SQL). Clusters with ≥2 caller files become findings. MED, 0.7 — LLM
// LLM filters trivial cases. Instance-style writes + Prisma relation
// writes deferred (need flow analysis).
export function detectSharedDbWrites(input: SharedDbWriteDetectorInput): Finding[] {
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

  const writes: WriteCall[] = [];
  for (const sf of project.getSourceFiles()) {
    const relativeFile = path.relative(input.workspaceRoot, sf.getFilePath());
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const matched = matchAdapters(call);
      if (!matched) continue;
      const enclosing = findEnclosingFunction(call);
      const enclosingSource = enclosing
        ? trimEnclosingSource((enclosing as { getText(): string }).getText())
        : trimSnippet(call.getText());
      const enclosingName =
        (enclosing as { getName?: () => string | undefined } | null)?.getName?.() ?? undefined;
      const snippet = trimSnippet(call.getText());
      const line = call.getStartLineNumber();
      const endLine = call.getEndLineNumber();

      for (const column of matched.columns) {
        writes.push({
          entity: matched.entity.toLowerCase(),
          column,
          adapter: matched.adapter,
          file: relativeFile,
          line,
          endLine,
          snippet,
          enclosingName,
          enclosingSource,
        });
      }
    }
  }

  // Cluster by entity.column; emit when ≥ 2 distinct files write.
  const byKey = new Map<string, WriteCall[]>();
  for (const w of writes) {
    const key = `${w.entity}.${w.column}`;
    const list = byKey.get(key) ?? [];
    list.push(w);
    byKey.set(key, list);
  }

  const findings: Finding[] = [];
  for (const [key, list] of byKey) {
    const distinctFiles = new Set(list.map((w) => w.file));
    if (distinctFiles.size < 2) continue;

    const adapters = [...new Set(list.map((w) => w.adapter))];
    const fileCount = distinctFiles.size;
    const callCount = list.length;
    const exampleFiles = [...distinctFiles].slice(0, 6).join(', ');

    findings.push({
      detectorId: 'shared-db-write',
      severity: 'medium',
      confidence: 0.7,
      layer: 1,
      title: `Shared DB column write: \`${key}\` across ${fileCount} files (${callCount} call sites, adapters: ${adapters.join('+')})`,
      description: [
        `Multiple functions write the same database column \`${key}\`.`,
        `If any two of these can execute concurrently (HTTP handler + background worker, two webhook handlers, parallel job consumers, two services in a multi-workspace group), the second write may stomp the first — the lost-update class of distributed race.`,
        ``,
        `Locations:`,
        ...list.map((w) => `- ${w.file}:${w.line} (${w.adapter}) \`${w.snippet}\``),
        ``,
        `Files involved: ${exampleFiles}${distinctFiles.size > 6 ? ', …' : ''}`,
      ].join('\n'),
      evidence: list.slice(0, 8).map((w) => ({
        file: w.file,
        range: { startLine: w.line, endLine: w.endLine },
        snippet: w.enclosingSource,
        note: JSON.stringify({
          entity: w.entity,
          column: w.column,
          adapter: w.adapter,
          enclosingName: w.enclosingName ?? '',
        }),
      })),
      suggestion:
        'Coordinate the writes via a single owner (one service is the source of truth, others publish events), wrap concurrent paths in an optimistic-locking version check, or merge into a single transactional update. If the writes are guaranteed serialised (queue, mutex, single-instance worker), document the synchronisation and mark this finding as a false positive.',
      fingerprint: `shared-db-write:${stableHash(key)}`,
    });
  }
  return findings;
}

interface AdapterMatch {
  adapter: string;
  entity: string;
  columns: Set<string>;
}

/** Try each adapter in turn; return the first match. */
function matchAdapters(call: CallExpression): AdapterMatch | null {
  return (
    matchPrisma(call) ||
    matchSequelize(call) ||
    matchTypeOrm(call) ||
    matchMongoose(call) ||
    matchKnex(call) ||
    matchDrizzle(call) ||
    matchRawSql(call)
  );
}

// ---------- Prisma --------------------------------------------------------

const PRISMA_WRITE_METHODS = new Set(['update', 'updateMany', 'upsert', 'create', 'createMany']);

function matchPrisma(call: CallExpression): AdapterMatch | null {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const methodAccess = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const method = methodAccess.getName();
  if (!PRISMA_WRITE_METHODS.has(method)) return null;

  const entityAccess = methodAccess.getExpression();
  if (entityAccess.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const entityNode = entityAccess as PropertyAccessExpression;
  const head = entityNode.getExpression().getText();
  // Heuristic: only match when the chain head looks like a Prisma client — common
  // names are `prisma`, `db`, `tx`, `client`, or anything ending in `Prisma`/`Client`.
  if (!/^(prisma|db|tx|client|.*Prisma|.*Client)$/i.test(head)) return null;
  const entity = entityNode.getName();

  const [arg] = call.getArguments();
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
  const cols = new Set<string>();
  if (method === 'upsert') {
    for (const propName of ['update', 'create']) {
      const sub = pickObjectProperty(arg as Node, propName);
      if (sub) collectPropertyNames(sub, cols);
    }
  } else {
    const data = pickObjectProperty(arg as Node, 'data');
    if (data) {
      if (data.getKind() === SyntaxKind.ObjectLiteralExpression) {
        collectPropertyNames(data, cols);
      } else if (data.getKind() === SyntaxKind.ArrayLiteralExpression) {
        for (const row of data.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
          collectPropertyNames(row, cols);
        }
      }
    }
  }
  if (cols.size === 0) return null;
  return { adapter: 'prisma', entity, columns: cols };
}

// ---------- Sequelize -----------------------------------------------------

// Sequelize: Model.update/upsert/create/bulkCreate + instance.update.
// Identifier head — non-ORM FPs filtered by cluster + LLM.
/**
 * Suffix blacklist for the Sequelize PascalCase heuristic. Real-world
 * codebases use `<Something>.create({...})` heavily for factories (JWT
 * verifiers, HTTP clients, builders) — surfaced as a smoke FP on pixadyx-be:
 * `CognitoJwtVerifier.create(...)` was treated as a Sequelize model write.
 * If the receiver name matches any of these patterns we skip the match.
 */
const NON_ORM_PASCAL_SUFFIXES = [
  /Verifier$/,
  /Builder$/,
  /Factory$/,
  /Client$/,
  /Service$/,
  /Manager$/,
  /Adapter$/,
  /Provider$/,
  /Logger$/,
  /Validator$/,
  /Parser$/,
  /Handler$/,
  /Helper$/,
  /Strategy$/,
  /Resolver$/,
  /Renderer$/,
  /Listener$/,
];

function matchSequelize(call: CallExpression): AdapterMatch | null {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const method = pa.getName();
  if (method !== 'update' && method !== 'upsert' && method !== 'create' && method !== 'bulkCreate')
    return null;
  const head = pa.getExpression();
  if (head.getKind() !== SyntaxKind.Identifier) return null;
  const entity = head.getText();
  // Sequelize models look like PascalCase identifiers. Skip non-PascalCase
  // to dodge most `someService.update(...)` false positives.
  if (!/^[A-Z][\w]*$/.test(entity)) return null;
  // Skip well-known non-ORM PascalCase patterns (factories, builders, ...).
  if (NON_ORM_PASCAL_SUFFIXES.some((re) => re.test(entity))) return null;

  const args = call.getArguments();
  if (args.length === 0) return null;

  const cols = new Set<string>();
  // M.update({ a:1 }, { where: ... }) — Sequelize requires `where`. Without
  // the second-arg options object we treat this as a non-Sequelize call.
  if (method === 'update') {
    if (args.length < 2) return null;
    const opts = args[1]!;
    if (opts.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const optsObj = opts as Node;
    // Must look like a Sequelize options object: `where`, `transaction`,
    // `returning`, `paranoid`, ... at minimum `where`.
    if (!pickObjectProperty(optsObj, 'where')) return null;
    const valueObj = args[0]!;
    if (valueObj.getKind() === SyntaxKind.ObjectLiteralExpression) {
      collectPropertyNames(valueObj as Node, cols);
    }
  } else if (method === 'upsert' || method === 'create') {
    // Require a second argument with Sequelize options (`transaction`,
    // `returning`, `where`, `defaults`, …) — this disambiguates from
    // factory `.create({ ... })` calls that take no options.
    if (args.length < 2) return null;
    const opts = args[1]!;
    if (opts.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const optsObj = opts as Node;
    const isSequelizeOpts =
      !!pickObjectProperty(optsObj, 'transaction') ||
      !!pickObjectProperty(optsObj, 'returning') ||
      !!pickObjectProperty(optsObj, 'where') ||
      !!pickObjectProperty(optsObj, 'defaults') ||
      !!pickObjectProperty(optsObj, 'individualHooks') ||
      !!pickObjectProperty(optsObj, 'validate') ||
      !!pickObjectProperty(optsObj, 'logging');
    if (!isSequelizeOpts) return null;
    const valueObj = args[0]!;
    if (valueObj.getKind() === SyntaxKind.ObjectLiteralExpression) {
      collectPropertyNames(valueObj as Node, cols);
    }
  } else if (method === 'bulkCreate') {
    // bulkCreate always passes an array as first arg and is rarely confused
    // with non-ORM factories. Accept regardless of options.
    const arr = args[0]!;
    if (arr.getKind() === SyntaxKind.ArrayLiteralExpression) {
      for (const row of (arr as Node).getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
        collectPropertyNames(row, cols);
      }
    }
  } else {
    return null;
  }
  if (cols.size === 0) return null;
  return { adapter: 'sequelize', entity, columns: cols };
}

// ---------- TypeORM ------------------------------------------------------

const TYPEORM_REPO_SUFFIX = /^(.+?)(Repo|Repository|repository)$/;

/**
 * TypeORM:
 *   - repo.update(<criteria>, { <cols> })
 *   - repo.save({ id, <cols> })
 *   - getRepository(E).update(<criteria>, { <cols> })
 *
 * Receiver must look like a repository handle (`*Repo` / `*Repository` /
 * literally `repository`) OR a `getRepository(E).method(...)` chain.
 */
function matchTypeOrm(call: CallExpression): AdapterMatch | null {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const method = pa.getName();
  if (method !== 'update' && method !== 'save') return null;

  const head = pa.getExpression();
  let entity: string | null = null;

  if (head.getKind() === SyntaxKind.Identifier) {
    const name = head.getText();
    const m = TYPEORM_REPO_SUFFIX.exec(name);
    if (m) entity = m[1]!;
    else if (/^repository$/i.test(name)) entity = name;
    else return null;
  } else {
    const inner = head.asKind(SyntaxKind.CallExpression);
    if (!inner) return null;
    const innerName = inner.getExpression().getText();
    if (!/(^|\.)getRepository$|getMongoRepository$|getCustomRepository$/.test(innerName))
      return null;
    const innerArgs = inner.getArguments();
    if (innerArgs.length === 0 || innerArgs[0]!.getKind() !== SyntaxKind.Identifier) return null;
    entity = innerArgs[0]!.getText();
  }
  if (!entity) return null;

  const args = call.getArguments();
  if (args.length === 0) return null;
  const cols = new Set<string>();
  if (method === 'update' && args.length >= 2) {
    const obj = args[1]!;
    if (obj.getKind() === SyntaxKind.ObjectLiteralExpression)
      collectPropertyNames(obj as Node, cols);
  } else if (method === 'save') {
    const obj = args[0]!;
    if (obj.getKind() === SyntaxKind.ObjectLiteralExpression)
      collectPropertyNames(obj as Node, cols);
  } else {
    return null;
  }
  if (cols.size === 0) return null;
  return { adapter: 'typeorm', entity, columns: cols };
}

// ---------- Mongoose -----------------------------------------------------

/**
 * Mongoose write methods. Each has a known argument shape:
 *   - `args[1]`-shape (filter/id first, update/replacement second):
 *       updateOne, updateMany, findOneAndUpdate, findOneAndReplace,
 *       findByIdAndUpdate, findByIdAndReplace, replaceOne
 *   - `args[0]`-shape (write doc / docs first):
 *       create, insertMany
 */
const MONGOOSE_ARGS1_METHODS = new Set([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findByIdAndUpdate',
  'findByIdAndReplace',
  'replaceOne',
]);
const MONGOOSE_ARGS0_METHODS = new Set(['create', 'insertMany']);

// Mongoose updateOne/findOneAndUpdate/create/insertMany. Receiver: Pascal
// ident, camel-Model, or this.<id>Model. $set unwrapped, $-ops stripped.
function matchMongoose(call: CallExpression): AdapterMatch | null {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const method = pa.getName();
  const isArgs1 = MONGOOSE_ARGS1_METHODS.has(method);
  const isArgs0 = MONGOOSE_ARGS0_METHODS.has(method);
  if (!isArgs1 && !isArgs0) return null;

  const head = pa.getExpression();
  const entity = resolveMongooseEntity(head);
  if (!entity) return null;

  const args = call.getArguments();
  const cols = new Set<string>();

  if (isArgs1) {
    if (args.length < 2) return null;
    const obj = args[1]!;
    if (obj.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const setBlock = pickObjectProperty(obj as Node, '$set');
    if (setBlock && setBlock.getKind() === SyntaxKind.ObjectLiteralExpression) {
      collectPropertyNames(setBlock, cols);
    } else {
      collectPropertyNames(obj as Node, cols);
      for (const c of [...cols]) if (c.startsWith('$')) cols.delete(c);
    }
  } else {
    if (args.length === 0) return null;
    const obj = args[0]!;
    if (obj.getKind() === SyntaxKind.ObjectLiteralExpression) {
      collectPropertyNames(obj as Node, cols);
    } else if (obj.getKind() === SyntaxKind.ArrayLiteralExpression) {
      for (const row of (obj as Node).getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
        collectPropertyNames(row, cols);
      }
    } else {
      return null;
    }
    for (const c of [...cols]) if (c.startsWith('$')) cols.delete(c);
  }
  if (cols.size === 0) return null;
  return { adapter: 'mongoose', entity, columns: cols };
}

/**
 * Resolve the entity name from a Mongoose-style receiver:
 *   - `Cat`                  → `cat`
 *   - `catModel`             → `cat`
 *   - `this.catModel`        → `cat`
 *
 * Returns null when the receiver doesn't look like a Mongoose model handle.
 */
function resolveMongooseEntity(head: Node): string | null {
  if (head.getKind() === SyntaxKind.Identifier) {
    const name = head.getText();
    // PascalCase model class — `Cat`, `User`.
    if (/^[A-Z][\w]*$/.test(name)) {
      if (NON_ORM_PASCAL_SUFFIXES.some((re) => re.test(name))) return null;
      return name;
    }
    // camelCase identifier ending in `Model` — `catModel`, `userModel`.
    const m = /^([a-z][\w]*?)Model$/.exec(name);
    if (m) return m[1]!;
    return null;
  }
  if (head.getKind() === SyntaxKind.PropertyAccessExpression) {
    const accessed = head as PropertyAccessExpression;
    if (accessed.getExpression().getKind() !== SyntaxKind.ThisKeyword) return null;
    const propName = accessed.getName();
    const m = /^([a-z][\w]*?)Model$/.exec(propName);
    if (m) return m[1]!;
    return null;
  }
  return null;
}

// ---------- Knex ---------------------------------------------------------

// Knex update/insert. Walks back through the chain to the
// knex('t')/db('t')/.from('t')/.into('t') head for the table name.
function matchKnex(call: CallExpression): AdapterMatch | null {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const method = pa.getName();
  if (method !== 'update' && method !== 'insert') return null;
  const args = call.getArguments();
  if (args.length === 0) return null;
  const obj = args[0]!;
  if (obj.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;

  const tableName = findKnexTable(pa.getExpression());
  if (!tableName) return null;
  const cols = new Set<string>();
  collectPropertyNames(obj as Node, cols);
  if (cols.size === 0) return null;
  return { adapter: 'knex', entity: tableName, columns: cols };
}

function findKnexTable(node: Node): string | null {
  let cur: Node | undefined = node;
  for (let i = 0; cur && i < 12; i++) {
    if (cur.getKind() === SyntaxKind.CallExpression) {
      const c = cur as CallExpression;
      const callExpr = c.getExpression();
      const calleeText = callExpr.getText();
      if (/^(knex|db|trx)$/.test(calleeText) || /\.(from|table|into)$/.test(calleeText)) {
        const [first] = c.getArguments();
        if (
          first &&
          (first.getKind() === SyntaxKind.StringLiteral ||
            first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral)
        ) {
          const lit =
            first.asKind(SyntaxKind.StringLiteral) ??
            first.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
          if (lit) return lit.getLiteralText();
        }
      }
    }
    cur = (cur as { getExpression?: () => Node }).getExpression?.();
  }
  return null;
}

// ---------- Drizzle ------------------------------------------------------

// Drizzle: db.update(t).set({...}) and db.insert(t).values({...}|[...]).
function matchDrizzle(call: CallExpression): AdapterMatch | null {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const method = pa.getName();
  if (method !== 'set' && method !== 'values') return null;
  const args = call.getArguments();
  if (args.length === 0) return null;

  let table: string | null = null;
  let cur: Node | undefined = pa.getExpression();
  for (let i = 0; cur && i < 10; i++) {
    if (cur.getKind() === SyntaxKind.CallExpression) {
      const c = cur as CallExpression;
      const inner = c.getExpression();
      const innerText = inner.getText();
      if (/\.(update|insert)$/.test(innerText) || /^(update|insert)$/.test(innerText)) {
        const [first] = c.getArguments();
        if (first && first.getKind() === SyntaxKind.Identifier) {
          table = first.getText();
          break;
        }
      }
    }
    cur = (cur as { getExpression?: () => Node }).getExpression?.();
  }
  if (!table) return null;

  const cols = new Set<string>();
  const obj = args[0]!;
  if (obj.getKind() === SyntaxKind.ObjectLiteralExpression) {
    collectPropertyNames(obj as Node, cols);
  } else if (obj.getKind() === SyntaxKind.ArrayLiteralExpression) {
    for (const row of (obj as Node).getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      collectPropertyNames(row, cols);
    }
  }
  if (cols.size === 0) return null;
  return { adapter: 'drizzle', entity: table, columns: cols };
}

// ---------- Raw SQL ------------------------------------------------------

// Raw SQL: .raw / .query / .$executeRaw[Unsafe] on UPDATE/INSERT shapes.
// Tiny regex grammar, not a SQL parser — comments + subqueries fall through.
function matchRawSql(call: CallExpression): AdapterMatch | null {
  const callee = call.getExpression();

  let sqlText: string | null = null;

  // .raw('SQL', ...) / .query('SQL', ...) / .$executeRawUnsafe('SQL', ...).
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
    const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const m = pa.getName();
    if (m !== 'raw' && m !== 'query' && m !== '$executeRaw' && m !== '$executeRawUnsafe') {
      return null;
    }
    const [first] = call.getArguments();
    if (!first) return null;
    const stringLit =
      first.asKind(SyntaxKind.StringLiteral) ??
      first.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
    if (stringLit) {
      sqlText = stringLit.getLiteralText();
    } else if (first.getKind() === SyntaxKind.TemplateExpression) {
      sqlText = first.getText();
    }
  }

  if (!sqlText) return null;
  const parsed = parseSqlWrite(sqlText);
  if (!parsed) return null;
  return {
    adapter: 'raw-sql',
    entity: parsed.table.toLowerCase(),
    columns: new Set(parsed.columns),
  };
}

/**
 * Parse a SQL string for UPDATE or INSERT writes. Returns `{ table, columns }`
 * or null. The grammar is intentionally narrow:
 *   UPDATE <table> SET <col>=…, <col>=…
 *   INSERT INTO <table> (<col>, <col>, …) VALUES (…)
 */
function parseSqlWrite(sql: string): { table: string; columns: string[] } | null {
  const cleaned = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // UPDATE ... SET col=..., col=...
  const upd = /^update\s+([\w."]+)\s+set\s+(.+?)(?:\swhere\s|$)/i.exec(cleaned);
  if (upd) {
    const table = stripQuotes(upd[1]!).split('.').pop()!;
    const setBlock = upd[2]!;
    const cols: string[] = [];
    for (const part of setBlock.split(',')) {
      const m = /^\s*"?([\w.]+)"?\s*=/.exec(part);
      if (m) cols.push(stripQuotes(m[1]!).split('.').pop()!);
    }
    if (cols.length === 0) return null;
    return { table, columns: cols };
  }
  // INSERT INTO <table> (col, col, ...) VALUES
  const ins = /^insert\s+into\s+([\w."]+)\s*\(([^)]+)\)\s*values/i.exec(cleaned);
  if (ins) {
    const table = stripQuotes(ins[1]!).split('.').pop()!;
    const cols = ins[2]!
      .split(',')
      .map((c) => stripQuotes(c.trim()).split('.').pop()!)
      .filter(Boolean);
    if (cols.length === 0) return null;
    return { table, columns: cols };
  }
  return null;
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`]+|["'`]+$/g, '');
}

// ---------- shared helpers -----------------------------------------------

function pickObjectProperty(obj: Node, name: string): Node | null {
  const olit = obj.asKind(SyntaxKind.ObjectLiteralExpression);
  if (!olit) return null;
  const prop = olit.getProperty(name);
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  return (prop as { getInitializer(): Node | undefined }).getInitializer() ?? null;
}

function collectPropertyNames(obj: Node, into: Set<string>): void {
  const olit = obj.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  for (const prop of olit.getProperties()) {
    if (
      prop.getKind() === SyntaxKind.PropertyAssignment ||
      prop.getKind() === SyntaxKind.ShorthandPropertyAssignment
    ) {
      const named = prop as { getName?: () => string };
      if (typeof named.getName === 'function') into.add(named.getName());
    }
  }
}

function findEnclosingFunction(node: Node): Node | null {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const k = cur.getKind();
    if (
      k === SyntaxKind.FunctionDeclaration ||
      k === SyntaxKind.MethodDeclaration ||
      k === SyntaxKind.ArrowFunction ||
      k === SyntaxKind.FunctionExpression
    ) {
      return cur;
    }
    cur = cur.getParent();
  }
  return null;
}
