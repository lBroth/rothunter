import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  Project,
  SyntaxKind,
  type ArrowFunction,
  type CallSignatureDeclaration,
  type ClassDeclaration,
  type ConstructSignatureDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type IndexSignatureDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  type PropertyDeclaration,
  type PropertySignature,
  type TypeAliasDeclaration,
  type TypeLiteralNode,
  type VariableDeclaration,
} from 'ts-morph';
import { logger } from '../utils/logger.js';
import { loadGitignore, enumerateSourceFiles } from '../utils/gitignore.js';
import { resolveImport, type ImportRecord } from '../graph/import-graph.js';
import { loadTsconfigPaths } from '../graph/tsconfig-paths.js';
import type { FieldStructure, FunctionStructure, SymbolRecord, TypeStructure } from '../types.js';

export interface ParseOptions {
  workspaceRoot: string;
  tsConfigFilePath?: string;
  filePatterns?: string[];
  includeNodeModules?: boolean;
  ignore?: string[];
  /**
   * Explicit list of file paths (absolute or workspace-relative) to scan.
   * When set, overrides `filePatterns`. Used by `--diff` mode to restrict the
   * scan to files changed in a git range.
   */
  files?: string[];
}

export interface ParseResult {
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  /** All workspace-relative file paths that were parsed (post node_modules/dist filtering). */
  files: string[];
}

export class TypeScriptParser {
  /** Backwards-compatible shortcut: returns only the symbols array. */
  async parseWorkspace(opts: ParseOptions): Promise<SymbolRecord[]> {
    return (await this.parseWorkspaceFull(opts)).symbols;
  }

  /** Full parse — symbols + imports + file list, built in a single ts-morph project. */
  async parseWorkspaceFull(opts: ParseOptions): Promise<ParseResult> {
    const project = new Project({
      tsConfigFilePath: opts.tsConfigFilePath,
      skipAddingFilesFromTsConfig: !opts.tsConfigFilePath,
      skipFileDependencyResolution: true,
    });

    // File exclusions come exclusively from `.gitignore` + the
    // workspace's `.rothunterignore` (gitignore-syntax extension).
    // The matcher bakes in `node_modules` + `.git` so we keep sane
    // defaults even on workspaces that ship no ignore file. Operator
    // tunes everything else through their own `.gitignore` —
    // rothunter never carries a parallel skip list that drifts.
    const gitignore = loadGitignore(opts.workspaceRoot);

    if (!opts.tsConfigFilePath) {
      if (opts.files && opts.files.length > 0) {
        const absolute = opts.files.map((f) =>
          path.isAbsolute(f) ? f : path.join(opts.workspaceRoot, f),
        );
        project.addSourceFilesAtPaths(absolute);
      } else {
        // Pre-load enumeration: walk the workspace ONCE, respecting
        // every .gitignore + .rothunterignore rule (incl. nested ones),
        // and only hand ts-morph the exact files we want it to parse.
        // Skipping ts-morph's own glob keeps `node_modules/`, `dist/`,
        // and every other operator-ignored tree out of memory — a real
        // monorepo would otherwise blow the V8 heap loading 60 k+ files
        // before any filter ran.
        const exts =
          opts.filePatterns?.flatMap((p) => {
            const m = /\*\.(\w+)$/.exec(p);
            return m ? [`.${m[1]}`] : [];
          }) ?? ['.ts', '.tsx'];
        const enumerated = enumerateSourceFiles(opts.workspaceRoot, gitignore, exts);
        if (enumerated.length > 0) {
          project.addSourceFilesAtPaths(
            enumerated.map((rel) => path.join(opts.workspaceRoot, rel)),
          );
        }
      }
    }

    // Load tsconfig path aliases once per workspace — used by resolveImport
    // for bare specifiers like `@/foo`, `~/bar`, `@app/lib`.
    const tsconfigPaths = loadTsconfigPaths(opts.workspaceRoot);

    const records: SymbolRecord[] = [];
    const imports: ImportRecord[] = [];
    const files: string[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      const relativeFile = path.relative(opts.workspaceRoot, filePath);
      if (gitignore.ignores(relativeFile.replace(/\\/g, '/'))) continue;
      files.push(relativeFile);

      for (const iface of sourceFile.getInterfaces()) {
        records.push(this.fromInterface(iface, relativeFile));
      }
      for (const alias of sourceFile.getTypeAliases()) {
        const record = this.fromTypeAlias(alias, relativeFile);
        if (record) records.push(record);
      }
      for (const fn of sourceFile.getFunctions()) {
        const record = this.fromFunction(fn, relativeFile);
        if (record) records.push(record);
      }
      // Top-level `const Foo = () => ...` / `const Foo = function() {...}` —
      // the canonical shape for React functional components and many helper
      // utilities. Treat them as function symbols so duplicate-function works.
      for (const stmt of sourceFile.getVariableStatements()) {
        for (const decl of stmt.getDeclarations()) {
          const record = this.fromVariableFunction(decl, stmt.isExported(), relativeFile);
          if (record) records.push(record);
        }
      }
      for (const cls of sourceFile.getClasses()) {
        const record = this.fromClass(cls, relativeFile);
        if (record) records.push(record);
      }
      for (const decl of sourceFile.getImportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        const namedImports = decl.getNamedImports().map((ni) => {
          // Use the original exported name (LHS of `as` clause if present),
          // since dead-export matching is keyed on the *target's* exported name.
          return ni.getName();
        });
        const defaultImport = decl.getDefaultImport()?.getText();
        const namespaceAlias = decl.getNamespaceImport()?.getText();
        imports.push({
          source: relativeFile,
          specifier,
          target: resolveImport(opts.workspaceRoot, relativeFile, specifier, tsconfigPaths),
          namedImports,
          defaultImport: defaultImport ?? undefined,
          namespaceAlias: namespaceAlias ?? undefined,
          isReExport: false,
          isStarReExport: false,
        });
      }
      for (const decl of sourceFile.getExportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        if (!specifier) continue;
        const named = decl.getNamedExports().map((ne) => ne.getName());
        const isStarReExport = decl.isNamespaceExport() && named.length === 0;
        imports.push({
          source: relativeFile,
          specifier,
          target: resolveImport(opts.workspaceRoot, relativeFile, specifier, tsconfigPaths),
          namedImports: named,
          isReExport: true,
          isStarReExport,
          reExportNames: named,
        });
      }
      // Dynamic imports: `await import('./x')` or `import('./x').then(...)`.
      // ts-morph does not surface them as import declarations, so we walk
      // the CallExpression AST. Treated as a namespace import — we cannot
      // statically know which exports the destructuring at the call site
      // will use, so all of the target's exports are considered consumed.
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
        const [argNode] = call.getArguments();
        if (!argNode) continue;
        const stringArg = argNode.asKind(SyntaxKind.StringLiteral);
        if (!stringArg) continue;
        const specifier = stringArg.getLiteralText();
        imports.push({
          source: relativeFile,
          specifier,
          target: resolveImport(opts.workspaceRoot, relativeFile, specifier, tsconfigPaths),
          namedImports: [],
          namespaceAlias: '__dynamic__',
          isReExport: false,
          isStarReExport: false,
        });
      }
    }

    logger.info(
      { symbols: records.length, imports: imports.length, files: files.length },
      'TypeScript parser: workspace scanned',
    );
    return { symbols: records, imports, files };
  }

  private isDefault(node: { isDefaultExport?: () => boolean }): boolean {
    try {
      return node.isDefaultExport?.() ?? false;
    } catch {
      return false;
    }
  }

  private fromInterface(iface: InterfaceDeclaration, file: string): SymbolRecord {
    const fields = [
      ...iface.getProperties().map((p) => this.fieldFromProperty(p)),
      ...iface.getMethods().map((m) => this.fieldFromMethod(m)),
      ...iface.getIndexSignatures().map((ix) => this.fieldFromIndexSignature(ix)),
      ...iface.getCallSignatures().map((cs) => this.fieldFromCallSignature(cs)),
      ...iface.getConstructSignatures().map((cs) => this.fieldFromConstructSignature(cs)),
    ];
    const structure: TypeStructure = { kind: 'object', fields };
    const source = iface.getText();
    const startLine = iface.getStartLineNumber();
    const endLine = iface.getEndLineNumber();
    return {
      id: hashContent(file, startLine, source),
      kind: 'interface',
      name: iface.getName(),
      file,
      range: { startLine, endLine },
      source,
      exported: iface.isExported(),
      isDefault: this.isDefault(iface),
      structure,
    };
  }

  private fromTypeAlias(alias: TypeAliasDeclaration, file: string): SymbolRecord | null {
    const typeNode = alias.getTypeNode();
    if (!typeNode) return null;

    let structure: TypeStructure;
    if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
      const literal = typeNode as TypeLiteralNode;
      const fields = [
        ...literal.getProperties().map((p) => this.fieldFromProperty(p)),
        ...literal.getMethods().map((m) => this.fieldFromMethod(m)),
        ...literal.getIndexSignatures().map((ix) => this.fieldFromIndexSignature(ix)),
        ...literal.getCallSignatures().map((cs) => this.fieldFromCallSignature(cs)),
        ...literal.getConstructSignatures().map((cs) => this.fieldFromConstructSignature(cs)),
      ];
      structure = { kind: 'object', fields };
    } else if (typeNode.getKind() === SyntaxKind.UnionType) {
      structure = { kind: 'union', raw: typeNode.getText() };
    } else if (typeNode.getKind() === SyntaxKind.IntersectionType) {
      structure = { kind: 'intersection', raw: typeNode.getText() };
    } else {
      structure = { kind: 'unknown', raw: typeNode.getText() };
    }

    const source = alias.getText();
    const startLine = alias.getStartLineNumber();
    const endLine = alias.getEndLineNumber();

    return {
      id: hashContent(file, startLine, source),
      kind: 'type-alias',
      name: alias.getName(),
      file,
      range: { startLine, endLine },
      source,
      exported: alias.isExported(),
      isDefault: this.isDefault(alias),
      structure,
    };
  }

  /**
   * Extract a class as a structural symbol so duplicate-type clustering can
   * match it against interfaces, type aliases, and other classes that share
   * the same shape. Class methods become pseudo-fields (`()methodName`) using
   * the same convention as interfaces; instance properties become
   * regular fields; static members are skipped (different surface area).
   */
  private fromClass(cls: ClassDeclaration, file: string): SymbolRecord | null {
    const name = cls.getName();
    if (!name) return null; // anonymous class expressions handled elsewhere

    const properties: FieldStructure[] = cls
      .getInstanceProperties()
      .filter(
        (p): p is PropertyDeclaration =>
          p.getKind() === SyntaxKind.PropertyDeclaration,
      )
      .map((p) => this.fieldFromClassProperty(p));

    const methods: FieldStructure[] = cls
      .getInstanceMethods()
      .map((m) => this.fieldFromClassMethod(m));

    const fields = [...properties, ...methods];
    const structure: TypeStructure = { kind: 'object', fields };
    const source = cls.getText();
    const startLine = cls.getStartLineNumber();
    const endLine = cls.getEndLineNumber();
    return {
      id: hashContent(file, startLine, source),
      kind: 'class',
      name,
      file,
      range: { startLine, endLine },
      source,
      exported: cls.isExported(),
      isDefault: this.isDefault(cls),
      structure,
    };
  }

  private fieldFromClassProperty(prop: PropertyDeclaration): FieldStructure {
    const name = prop.getName();
    const typeNode = prop.getTypeNode();
    const type = typeNode ? typeNode.getText() : prop.getType().getText();
    return {
      name,
      type: normalizeTypeText(type),
      optional: prop.hasQuestionToken(),
      readonly: prop.isReadonly(),
    };
  }

  private fieldFromClassMethod(method: MethodDeclaration): FieldStructure {
    const name = method.getName();
    const params = method
      .getParameters()
      .map((p) => `${p.getName()}:${normalizeTypeText(p.getType().getText())}`)
      .join(',');
    const ret = normalizeTypeText(method.getReturnType().getText());
    return {
      name: `()${name}`,
      type: `(${params})=>${ret}`,
      optional: false,
      readonly: false,
    };
  }

  /**
   * Capture `const Foo = () => ...` / `const Foo = function() {...}` as a
   * function symbol. The variable name becomes the symbol name; the arrow
   * or function-expression body provides params + body. React functional
   * components, mapped utility functions, and event-handler factories all
   * land here.
   *
   * Returns null when the initializer is not a callable shape.
   */
  private fromVariableFunction(
    decl: VariableDeclaration,
    isExported: boolean,
    file: string,
  ): SymbolRecord | null {
    if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) {
      return null;
    }
    const init = decl.getInitializer();
    if (!init) return null;
    const fnLike: ArrowFunction | FunctionExpression | undefined =
      init.asKind(SyntaxKind.ArrowFunction) ?? init.asKind(SyntaxKind.FunctionExpression);
    if (!fnLike) return null;

    const body = fnLike.getBody();
    if (!body) return null;

    const params: FieldStructure[] = fnLike.getParameters().map((p) => ({
      name: p.getName(),
      type: normalizeTypeText(p.getTypeNode()?.getText() ?? p.getType().getText()),
      optional: p.isOptional() || p.hasInitializer(),
      readonly: p.isReadonly(),
    }));
    const returnType = normalizeTypeText(fnLike.getReturnType().getText());
    const bodyText = body.getText();
    const bodyNormalized = collapseSource(bodyText);
    const bodyShingles = computeShingles(bodyNormalized);

    const structure: FunctionStructure = {
      kind: 'function',
      params,
      returnType,
      async: fnLike.isAsync(),
      generator: fnLike.isKind(SyntaxKind.FunctionExpression) ? fnLike.isGenerator() : false,
      body: bodyText,
      bodyNormalized,
      bodyShingles,
    };

    const source = decl.getText();
    const startLine = decl.getStartLineNumber();
    const endLine = decl.getEndLineNumber();
    return {
      id: hashContent(file, startLine, source),
      kind: 'function',
      name: decl.getName(),
      file,
      range: { startLine, endLine },
      source,
      exported: isExported,
      structure,
    };
  }

  private fromFunction(fn: FunctionDeclaration, file: string): SymbolRecord | null {
    const name = fn.getName();
    if (!name) return null; // skip anonymous function expressions
    const body = fn.getBody();
    if (!body) return null; // overload signature with no body — skip

    const params: FieldStructure[] = fn.getParameters().map((p) => ({
      name: p.getName(),
      type: normalizeTypeText(p.getTypeNode()?.getText() ?? p.getType().getText()),
      optional: p.isOptional() || p.hasInitializer(),
      readonly: p.isReadonly(),
    }));
    const returnType = normalizeTypeText(fn.getReturnType().getText());
    const bodyText = body.getText();
    const bodyNormalized = collapseSource(bodyText);
    const bodyShingles = computeShingles(bodyNormalized);

    const structure: FunctionStructure = {
      kind: 'function',
      params,
      returnType,
      async: fn.isAsync(),
      generator: fn.isGenerator(),
      body: bodyText,
      bodyNormalized,
      bodyShingles,
    };

    const source = fn.getText();
    const startLine = fn.getStartLineNumber();
    const endLine = fn.getEndLineNumber();
    return {
      id: hashContent(file, startLine, source),
      kind: 'function',
      name,
      file,
      range: { startLine, endLine },
      source,
      exported: fn.isExported(),
      isDefault: this.isDefault(fn),
      structure,
    };
  }

  private fieldFromProperty(prop: PropertySignature): FieldStructure {
    const name = prop.getName();
    const typeNode = prop.getTypeNode();
    const type = typeNode ? typeNode.getText() : prop.getType().getText();
    return {
      name,
      type: normalizeTypeText(type),
      optional: prop.hasQuestionToken(),
      readonly: prop.isReadonly(),
    };
  }

  private fieldFromMethod(method: MethodSignature): FieldStructure {
    const name = method.getName();
    const params = method
      .getParameters()
      .map((p) => `${p.getName()}:${normalizeTypeText(p.getType().getText())}`)
      .join(',');
    const ret = normalizeTypeText(method.getReturnType().getText());
    return {
      name: `()${name}`,
      type: `(${params})=>${ret}`,
      optional: method.hasQuestionToken(),
      readonly: false,
    };
  }

  private fieldFromIndexSignature(ix: IndexSignatureDeclaration): FieldStructure {
    const keyType = normalizeTypeText(ix.getKeyTypeNode()?.getText() ?? 'string');
    const valueType = normalizeTypeText(ix.getReturnType().getText());
    return {
      name: `[${keyType}]`,
      type: valueType,
      optional: false,
      readonly: ix.isReadonly(),
    };
  }

  private fieldFromCallSignature(cs: CallSignatureDeclaration): FieldStructure {
    const params = cs
      .getParameters()
      .map((p) => `${p.getName()}:${normalizeTypeText(p.getType().getText())}`)
      .join(',');
    const ret = normalizeTypeText(cs.getReturnType().getText());
    return {
      name: '()',
      type: `(${params})=>${ret}`,
      optional: false,
      readonly: false,
    };
  }

  private fieldFromConstructSignature(cs: ConstructSignatureDeclaration): FieldStructure {
    const params = cs
      .getParameters()
      .map((p) => `${p.getName()}:${normalizeTypeText(p.getType().getText())}`)
      .join(',');
    const ret = normalizeTypeText(cs.getReturnType().getText());
    return {
      name: 'new()',
      type: `(${params})=>${ret}`,
      optional: false,
      readonly: false,
    };
  }
}

function normalizeTypeText(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Collapse a function body to a hash-stable form: strip block + line comments,
 * collapse whitespace, lowercase nothing (identifiers stay case-sensitive).
 * Used for the body-similarity signature; local-identifier renaming happens
 * later in the normalizer.
 */
function collapseSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHINGLE_SIZE = 4;
const TS_KEYWORDS_FOR_SHINGLING = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'this', 'super', 'class', 'extends',
  'implements', 'function', 'const', 'let', 'var', 'typeof', 'instanceof', 'in', 'of',
  'await', 'async', 'yield', 'true', 'false', 'null', 'undefined', 'void', 'delete',
  'as', 'is', 'satisfies', 'keyof', 'readonly', 'public', 'private', 'protected', 'static',
  'export', 'import', 'from', 'string', 'number', 'boolean', 'object', 'never', 'any',
  'unknown', 'bigint', 'symbol', 'Date', 'Array', 'Map', 'Set', 'Promise',
]);

/**
 * Tokenise a collapsed function body and emit a set of 4-token shingles for
 * the near-duplicate Jaccard pass. Identifier tokens that are not TypeScript
 * keywords or common built-ins are replaced with `_` so renames don't perturb
 * similarity.
 */
function computeShingles(bodyNormalized: string): Set<string> {
  // Strip quoted string literals so their internal text doesn't dominate the
  // shingle set — they're irrelevant for "is the same logic" similarity.
  const stripped = bodyNormalized
    .replace(/`[^`]*`/g, '`_`')
    .replace(/"[^"]*"/g, '"_"')
    .replace(/'[^']*'/g, "'_'");
  const tokens = stripped
    .replace(/([{}()\[\].,;:?<>=!+\-*/%&|^~])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0)
    .map((t) => {
      if (/^[A-Za-z_$][\w$]*$/.test(t)) {
        return TS_KEYWORDS_FOR_SHINGLING.has(t) ? t : '_';
      }
      return t;
    });
  const out = new Set<string>();
  if (tokens.length < SHINGLE_SIZE) {
    out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i <= tokens.length - SHINGLE_SIZE; i++) {
    out.add(tokens.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return out;
}

function hashContent(file: string, startLine: number, source: string): string {
  return crypto
    .createHash('sha256')
    .update(`${file}:${startLine}:${source}`)
    .digest('hex')
    .slice(0, 16);
}
