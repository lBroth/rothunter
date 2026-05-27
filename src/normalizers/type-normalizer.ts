import * as crypto from 'node:crypto';
import type { FieldStructure, FunctionStructure, SymbolRecord } from '../types.js';

const FIELD_NAME_SYNONYMS: Record<string, string> = {
  uid: 'id',
  userid: 'id',
  identifier: 'id',
  mail: 'email',
  emailaddress: 'email',
  fullname: 'name',
  displayname: 'name',
  username: 'name',
  created: 'createdat',
  createdon: 'createdat',
  updated: 'updatedat',
  modified: 'updatedat',
  modifiedon: 'updatedat',
};

export class TypeNormalizer {
  normalize(record: SymbolRecord): SymbolRecord {
    if (record.structure?.kind === 'function') {
      return this.normalizeFunction(record, record.structure);
    }
    if (!record.structure || record.structure.kind !== 'object') {
      const raw = record.structure && 'raw' in record.structure ? record.structure.raw : undefined;
      const fallback = raw ?? record.source;
      const h = sha256(fallback);
      return {
        ...record,
        hashStrict: h,
        hashStructural: h,
        hashNormalizedNames: h,
        canonicalSignature: fallback,
      };
    }

    const fields = record.structure.fields ?? [];
    const sortedByName = [...fields].sort((a, b) => a.name.localeCompare(b.name));

    const strictSig = serializeFields(sortedByName, { withNames: true, normalizeNames: false });
    // For normalized-names matching, sort by the *normalized* name so that snake↔camel
    // variants land in the same order before hashing (e.g. `user_id` and `uid` both → `id`).
    const sortedByNormalizedName = [...fields].sort((a, b) =>
      normalizeFieldName(a.name).localeCompare(normalizeFieldName(b.name)),
    );
    const normalizedNamesSig = serializeFields(sortedByNormalizedName, {
      withNames: true,
      normalizeNames: true,
    });

    // Structural ignores names completely → sort by type to get a stable order
    const sortedByType = [...fields].sort((a, b) =>
      canonicalType(a.type).localeCompare(canonicalType(b.type)),
    );
    const structuralSig = serializeFields(sortedByType, {
      withNames: false,
      normalizeNames: false,
    });

    return {
      ...record,
      hashStrict: sha256(strictSig),
      hashStructural: sha256(structuralSig),
      hashNormalizedNames: sha256(normalizedNamesSig),
      canonicalSignature: strictSig,
    };
  }

  normalizeAll(records: SymbolRecord[]): SymbolRecord[] {
    return records.map((r) => this.normalize(r));
  }

  /**
   * Compute three function hashes:
   *   strict          : `(param:type, ...) => returnType { body-normalized }`
   *   structural      : same, but param names dropped and body identifiers stripped
   *                     of token-identity (keep only structural tokens — kw, punct, types)
   *   normalized-names: param names mapped through the synonym table, body unchanged
   *
   * `bodyNormalized` was already whitespace-collapsed by the parser.
   */
  private normalizeFunction(record: SymbolRecord, fn: FunctionStructure): SymbolRecord {
    const paramsStrict = serializeFunctionParams(fn.params, {
      withNames: true,
      normalizeNames: false,
    });
    const paramsNormalized = serializeFunctionParams(fn.params, {
      withNames: true,
      normalizeNames: true,
    });
    const paramsStructural = serializeFunctionParams(fn.params, {
      withNames: false,
      normalizeNames: false,
    });
    const ret = canonicalType(fn.returnType);
    const flags = `${fn.async ? 'a' : ''}${fn.generator ? 'g' : ''}`;

    const strictSig = `${flags}(${paramsStrict})=>${ret}::${fn.bodyNormalized}`;
    const normalizedSig = `${flags}(${paramsNormalized})=>${ret}::${fn.bodyNormalized}`;
    const structuralSig = `${flags}(${paramsStructural})=>${ret}::${anonymizeIdentifiers(fn.bodyNormalized)}`;

    return {
      ...record,
      hashStrict: sha256(strictSig),
      hashStructural: sha256(structuralSig),
      hashNormalizedNames: sha256(normalizedSig),
      canonicalSignature: strictSig,
    };
  }
}

function serializeFunctionParams(params: FieldStructure[], opts: SerializeOptions): string {
  return params
    .map((p, i) => {
      const name = opts.withNames
        ? opts.normalizeNames
          ? normalizeFieldName(p.name)
          : p.name
        : `_${i}`;
      const opt = p.optional ? '?' : '';
      return `${name}${opt}:${canonicalType(p.type)}`;
    })
    .join(',');
}

/**
 * Replace every identifier token in a (collapsed) function body with a generic
 * placeholder. Keeps keywords, punctuation, literals, and TypeScript built-in
 * names so the structural skeleton stays intact while user-chosen identifiers
 * (locals, parameter names, called functions) get equalised.
 */
function anonymizeIdentifiers(body: string): string {
  const TS_KEYWORDS = new Set([
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'default',
    'break',
    'continue',
    'return',
    'throw',
    'try',
    'catch',
    'finally',
    'new',
    'this',
    'super',
    'class',
    'extends',
    'implements',
    'function',
    'const',
    'let',
    'var',
    'typeof',
    'instanceof',
    'in',
    'of',
    'await',
    'async',
    'yield',
    'true',
    'false',
    'null',
    'undefined',
    'void',
    'delete',
    'as',
    'is',
    'satisfies',
    'keyof',
    'readonly',
    'public',
    'private',
    'protected',
    'static',
    'export',
    'import',
    'from',
    'string',
    'number',
    'boolean',
    'object',
    'never',
    'any',
    'unknown',
    'bigint',
    'symbol',
    'Date',
    'Array',
    'Map',
    'Set',
    'Promise',
    'Record',
    'Partial',
    'Pick',
    'Omit',
    'Readonly',
    'ReadonlyArray',
  ]);
  return body.replace(/[A-Za-z_$][\w$]*/g, (token) => (TS_KEYWORDS.has(token) ? token : '_'));
}

interface SerializeOptions {
  withNames: boolean;
  normalizeNames: boolean;
}

function serializeFields(fields: FieldStructure[], opts: SerializeOptions): string {
  if (fields.length === 0) return '{}';
  const parts = fields.map((f) => {
    const name = opts.withNames ? (opts.normalizeNames ? normalizeFieldName(f.name) : f.name) : '_';
    const type = canonicalType(f.type);
    const opt = f.optional ? '?' : '';
    return `${name}${opt}:${type}`;
  });
  return `{${parts.join(',')}}`;
}

function normalizeFieldName(name: string): string {
  // snake_case → camelCase
  let normalized = name.replace(/[_-]([a-zA-Z])/g, (_, c) => c.toUpperCase());
  // Strip any residual underscores or dashes (e.g. before digits: `street_line_1`
  // → `streetLine_1` from the previous step → `streetLine1`).
  normalized = normalized.replace(/[_-]+/g, '');
  // lowercase for synonym lookup, then map
  const lower = normalized.toLowerCase();
  return FIELD_NAME_SYNONYMS[lower] ?? lower;
}

function canonicalType(t: string): string {
  const compact = t.replace(/\s+/g, '');
  // Only canonicalize top-level unions. Don't touch unions nested inside generics
  // or function signatures (depth check via balanced brackets).
  if (!hasTopLevelUnion(compact)) return compact;
  const members = splitTopLevelUnion(compact)
    .map((m) => m.replace(/^undefined$/, '')) // drop `undefined` member entirely
    .filter((m) => m.length > 0);
  if (members.length === 0) return compact;
  members.sort();
  return members.length === 1 ? members[0]! : members.join('|');
}

function hasTopLevelUnion(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '|' && depth === 0) return true;
  }
  return false;
}

function splitTopLevelUnion(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '|' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
