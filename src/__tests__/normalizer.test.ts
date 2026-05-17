import { describe, expect, it } from '@jest/globals';
import { TypeNormalizer } from '../normalizers/type-normalizer.js';
import type { SymbolRecord } from '../types.js';

function objectRecord(name: string, fields: Array<[string, string, { optional?: boolean }?]>): SymbolRecord {
  return {
    id: `test-${name}`,
    kind: 'interface',
    name,
    file: `test/${name}.ts`,
    range: { startLine: 1, endLine: 2 },
    source: `interface ${name} {}`,
    exported: true,
    structure: {
      kind: 'object',
      fields: fields.map(([n, t, o]) => ({
        name: n,
        type: t,
        optional: o?.optional ?? false,
        readonly: false,
      })),
    },
  };
}

describe('TypeNormalizer', () => {
  const norm = new TypeNormalizer();

  describe('strict hash', () => {
    it('matches identical interfaces regardless of field declaration order', () => {
      const a = norm.normalize(
        objectRecord('A', [
          ['name', 'string'],
          ['id', 'string'],
          ['age', 'number'],
        ]),
      );
      const b = norm.normalize(
        objectRecord('B', [
          ['id', 'string'],
          ['name', 'string'],
          ['age', 'number'],
        ]),
      );
      expect(a.hashStrict).toBe(b.hashStrict);
    });

    it('diverges when optional modifier differs', () => {
      const a = norm.normalize(objectRecord('A', [['name', 'string', { optional: true }]]));
      const b = norm.normalize(objectRecord('B', [['name', 'string']]));
      expect(a.hashStrict).not.toBe(b.hashStrict);
    });

    it('diverges when field types differ', () => {
      const a = norm.normalize(objectRecord('A', [['id', 'string']]));
      const b = norm.normalize(objectRecord('B', [['id', 'number']]));
      expect(a.hashStrict).not.toBe(b.hashStrict);
    });
  });

  describe('structural hash', () => {
    it('matches identical primitive layouts under different field names', () => {
      const a = norm.normalize(
        objectRecord('A', [
          ['orderId', 'string'],
          ['amount', 'number'],
          ['paid', 'boolean'],
        ]),
      );
      const b = norm.normalize(
        objectRecord('B', [
          ['invoiceId', 'string'],
          ['total', 'number'],
          ['settled', 'boolean'],
        ]),
      );
      expect(a.hashStructural).toBe(b.hashStructural);
    });

    it('diverges when one field type changes', () => {
      const a = norm.normalize(
        objectRecord('A', [
          ['x', 'string'],
          ['y', 'number'],
        ]),
      );
      const b = norm.normalize(
        objectRecord('B', [
          ['x', 'string'],
          ['y', 'string'],
        ]),
      );
      expect(a.hashStructural).not.toBe(b.hashStructural);
    });
  });

  describe('canonicalType (top-level union ordering)', () => {
    // The hashes are exposed through structural matching: two interfaces with
    // logically equivalent union types must collide.
    it('treats `string | null` and `null | string` as the same type', () => {
      const a = norm.normalize(
        objectRecord('A', [
          ['p', 'string | null'],
          ['q', 'string | null'],
          ['r', 'string | null'],
          ['s', 'string | null'],
        ]),
      );
      const b = norm.normalize(
        objectRecord('B', [
          ['p', 'null | string'],
          ['q', 'null | string'],
          ['r', 'null | string'],
          ['s', 'null | string'],
        ]),
      );
      expect(a.hashStrict).toBe(b.hashStrict);
    });

    it('strips trailing `| undefined` so `T | undefined` ≡ `T`', () => {
      const a = norm.normalize(objectRecord('A', [['v', 'string | undefined']]));
      const b = norm.normalize(objectRecord('B', [['v', 'string']]));
      expect(a.hashStrict).toBe(b.hashStrict);
    });

    it('does not split `|` inside generics or function signatures', () => {
      const a = norm.normalize(objectRecord('A', [['v', 'Map<string | number, boolean>']]));
      const b = norm.normalize(objectRecord('B', [['v', 'Map<number | string, boolean>']]));
      // Nested unions are NOT canonicalized — only top-level. So these should differ
      // (this is a known limitation, encoded here so a future change is intentional).
      expect(a.hashStrict).not.toBe(b.hashStrict);
    });
  });

  describe('normalized-names hash', () => {
    it('collapses snake_case ↔ camelCase ↔ kebab-case', () => {
      const snake = norm.normalize(
        objectRecord('Snake', [
          ['user_id', 'string'],
          ['full_name', 'string'],
          ['created_on', 'string'],
          ['email', 'string'],
        ]),
      );
      const camel = norm.normalize(
        objectRecord('Camel', [
          ['uid', 'string'],
          ['fullName', 'string'],
          ['createdAt', 'string'],
          ['mail', 'string'],
        ]),
      );
      expect(snake.hashNormalizedNames).toBe(camel.hashNormalizedNames);
    });

    it('strips leading underscores', () => {
      const a = norm.normalize(
        objectRecord('A', [
          ['_id', 'string'],
          ['_email', 'string'],
          ['_name', 'string'],
          ['_role', 'string'],
        ]),
      );
      const b = norm.normalize(
        objectRecord('B', [
          ['id', 'string'],
          ['email', 'string'],
          ['name', 'string'],
          ['role', 'string'],
        ]),
      );
      expect(a.hashNormalizedNames).toBe(b.hashNormalizedNames);
    });

    it('is invariant to field declaration order (sorts by normalized name)', () => {
      // Regression: previously sorted by raw name, which produced different
      // serialization orders for snake↔camel pairs and broke layer 2.
      const a = norm.normalize(
        objectRecord('A', [
          ['user_id', 'string'],
          ['mail', 'string'],
          ['full_name', 'string'],
          ['created_on', 'string'],
        ]),
      );
      const b = norm.normalize(
        objectRecord('B', [
          ['createdAt', 'string'],
          ['email', 'string'],
          ['fullName', 'string'],
          ['uid', 'string'],
        ]),
      );
      expect(a.hashNormalizedNames).toBe(b.hashNormalizedNames);
    });
  });
});
