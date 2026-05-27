import type { Finding, SymbolRecord, TypeStructure, FieldStructure } from '../types.js';
import { stableHash } from '../utils/hash.js';

export interface SchemaShapeDivergenceDetectorInput {
  symbols: ReadonlyArray<SymbolRecord>;
  /**
   * Max number of differing fields between two types to still be
   * considered "drifted" rather than unrelated. Default 2. A diff of 0
   * is left to `duplicate-type`; a diff of 3+ usually means the types
   * are genuinely about different things.
   */
  maxDriftFields?: number;
  /**
   * Skip pairs whose field intersection is below this fraction of the
   * smaller type's field count. Default 0.5 — two types must share more
   * than half their smaller-side fields before we call them drifted.
   * Stops the detector from grouping `User` and `OrderLineItem` just
   * because both happen to have an `id` field.
   */
  minSharedFraction?: number;
}

// Two exported types whose names share a common stem (`User` vs
// `UserDTO`, `CreateUser` request vs `User` model) and whose field
// sets diverge by 1–2 keys. The classic "we added a column to the
// model but forgot the DTO" drift. Duplicate-type only flags
// identical shapes; tsc never compares unrelated types. MED severity.
export function detectSchemaShapeDivergence(input: SchemaShapeDivergenceDetectorInput): Finding[] {
  const maxDrift = input.maxDriftFields ?? 2;
  const minShared = input.minSharedFraction ?? 0.5;

  // Only consider exported, object-shaped types with at least 3 fields
  // — below 3 fields the diff signal degrades into noise (`User { id,
  // name }` vs `Order { id, name }` would otherwise drift-match).
  const candidates: Array<{
    sym: SymbolRecord;
    fields: ReadonlyArray<FieldStructure>;
    stem: string;
  }> = [];
  for (const sym of input.symbols) {
    if (!sym.exported) continue;
    if (sym.kind !== 'interface' && sym.kind !== 'type-alias') continue;
    const struct = sym.structure as TypeStructure | undefined;
    if (!struct || struct.kind !== 'object' || !struct.fields) continue;
    if (struct.fields.length < 3) continue;
    candidates.push({ sym, fields: struct.fields, stem: nameStem(sym.name) });
  }

  // Group by stem. The stem deliberately collapses casing variants
  // (`userDto` → `user`) and known DTO/Request suffixes.
  const groups = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (c.stem.length < 3) continue; // single-letter stems are noise
    const arr = groups.get(c.stem) ?? [];
    arr.push(c);
    groups.set(c.stem, arr);
  }

  const findings: Finding[] = [];
  for (const [stem, group] of groups) {
    if (group.length < 2) continue;
    // Pairwise diff inside the group. O(n²) per group is fine because
    // groups stay small (a stem rarely has more than a handful of
    // variants in practice).
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const diff = diffFields(a.fields, b.fields);
        if (diff.added.length === 0 && diff.removed.length === 0) continue; // exact match → duplicate-type owns it
        const totalDriftFields = diff.added.length + diff.removed.length;
        if (totalDriftFields > maxDrift) continue;
        const shared =
          Math.min(a.fields.length, b.fields.length) -
          Math.max(diff.added.length, diff.removed.length);
        const smaller = Math.min(a.fields.length, b.fields.length);
        if (smaller > 0 && shared / smaller < minShared) continue;

        const findingPair = orderForReport(a, b, diff);
        findings.push({
          detectorId: 'schema-shape-divergence',
          severity: 'medium',
          confidence: 0.9,
          layer: 1,
          title:
            `Schema drift: \`${findingPair.left.sym.name}\` (${findingPair.left.sym.file}) ` +
            `vs \`${findingPair.right.sym.name}\` (${findingPair.right.sym.file})`,
          description:
            `These two exported types share the name stem \`${stem}\` and ${shared} field(s), ` +
            `but differ by ${totalDriftFields}: ` +
            `${findingPair.right.sym.name} ${formatDiff(findingPair.flippedDiff)}. ` +
            `Most often the cause is a column added (or removed) on one side of the model/DTO pair without the matching update on the other.`,
          evidence: [
            {
              file: a.sym.file,
              range: { startLine: a.sym.range.startLine, endLine: a.sym.range.endLine },
              snippet: a.sym.source.split('\n').slice(0, 4).join('\n'),
            },
            {
              file: b.sym.file,
              range: { startLine: b.sym.range.startLine, endLine: b.sym.range.endLine },
              snippet: b.sym.source.split('\n').slice(0, 4).join('\n'),
            },
          ],
          suggestion:
            `Decide whether the drift is intentional. If not, align the two types ` +
            `(usually by deriving one from the other via \`Pick\` / \`Omit\` / a zod schema). ` +
            `If intentional, give them genuinely different names so this detector ` +
            `stops clustering them on the same stem.`,
          fingerprint: `schema-shape-divergence:${stableHash(
            [a.sym.file, a.sym.name, b.sym.file, b.sym.name].sort().join('::'),
          )}`,
        });
      }
    }
  }
  return findings;
}

// Strip common DTO/request/response/view/schema suffixes (in any
// case) so `UserDTO`, `userDto`, `UserResponse`, and `User` cluster
// under the stem `user`. Words inside a longer compound (`UserAuth`,
// `UserProfile`) keep their compound stem — those are deliberately
// different types.
const STEM_SUFFIXES = [
  'dto',
  'dtos',
  'request',
  'requests',
  'response',
  'responses',
  'input',
  'inputs',
  'output',
  'outputs',
  'view',
  'views',
  'model',
  'models',
  'schema',
  'schemas',
  'type',
  'types',
  'payload',
  'payloads',
  'entity',
  'entities',
  'row',
  'rows',
  'record',
  'records',
];

function nameStem(name: string): string {
  let stem = name;
  // Strip leading `Create` / `Update` / `Patch` / `Get` / `List` /
  // `Delete` / `Read` action prefixes — typical for command/query
  // shapes.
  const lower = stem.toLowerCase();
  for (const action of ['create', 'update', 'patch', 'put', 'get', 'list', 'delete', 'read']) {
    if (lower.startsWith(action) && lower.length > action.length) {
      const ch = stem.charCodeAt(action.length);
      // Only strip when the next char is upper-case → preserves
      // `Createable` etc.
      if (ch >= 65 && ch <= 90) {
        stem = stem.slice(action.length);
        break;
      }
    }
  }
  // Strip a recognised suffix once.
  const stemLower = stem.toLowerCase();
  for (const sfx of STEM_SUFFIXES) {
    if (stemLower.endsWith(sfx) && stemLower.length > sfx.length) {
      stem = stem.slice(0, stem.length - sfx.length);
      break;
    }
  }
  return stem.toLowerCase();
}

interface FieldDiff {
  added: string[]; // present in b, absent in a
  removed: string[]; // present in a, absent in b
}

function diffFields(a: ReadonlyArray<FieldStructure>, b: ReadonlyArray<FieldStructure>): FieldDiff {
  const aNames = new Set(a.map((f) => f.name));
  const bNames = new Set(b.map((f) => f.name));
  const added: string[] = [];
  const removed: string[] = [];
  for (const n of bNames) if (!aNames.has(n)) added.push(n);
  for (const n of aNames) if (!bNames.has(n)) removed.push(n);
  added.sort();
  removed.sort();
  return { added, removed };
}

function orderForReport(
  a: { sym: SymbolRecord; fields: ReadonlyArray<FieldStructure> },
  b: { sym: SymbolRecord; fields: ReadonlyArray<FieldStructure> },
  diff: FieldDiff,
): {
  left: typeof a;
  right: typeof a;
  flippedDiff: FieldDiff;
} {
  // Report the smaller (or alphabetically first on tie) on the left so
  // the description reads as "right adds X, removes Y" relative to
  // left.
  if (a.fields.length < b.fields.length) return { left: a, right: b, flippedDiff: diff };
  if (a.fields.length > b.fields.length) {
    return {
      left: b,
      right: a,
      flippedDiff: { added: diff.removed, removed: diff.added },
    };
  }
  if (a.sym.name <= b.sym.name) return { left: a, right: b, flippedDiff: diff };
  return {
    left: b,
    right: a,
    flippedDiff: { added: diff.removed, removed: diff.added },
  };
}

function formatDiff(diff: FieldDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`adds \`${diff.added.join('`, `')}\``);
  }
  if (diff.removed.length > 0) {
    parts.push(`drops \`${diff.removed.join('`, `')}\``);
  }
  return parts.join(' and ');
}
