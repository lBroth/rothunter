import type { Finding, SymbolRecord, FunctionStructure } from '../types.js';
import { stableHash } from '../utils/hash.js';

export interface PublicAnyDetectorInput {
  symbols: ReadonlyArray<SymbolRecord>;
}

// Exported function with `any` in params or return. HIGH — caller-visible
// type hole. `any[]`, `Record<string, any>`, `any | T` count. `unknown` doesn't.
export function detectPublicAny(input: PublicAnyDetectorInput): Finding[] {
  const findings: Finding[] = [];
  for (const sym of input.symbols) {
    if (sym.kind !== 'function') continue;
    if (!sym.exported) continue;
    const fn = sym.structure as FunctionStructure | undefined;
    if (!fn || fn.kind !== 'function') continue;
    const offendingParams = fn.params.filter((p) => containsAny(p.type)).map((p) => p.name);
    const returnAny = containsAny(fn.returnType);
    if (offendingParams.length === 0 && !returnAny) continue;
    const where = [
      ...offendingParams.map((n) => `param \`${n}: any\``),
      ...(returnAny ? [`return \`${fn.returnType}\``] : []),
    ];
    findings.push({
      detectorId: 'public-any',
      severity: 'high',
      confidence: 0.97,
      layer: 1,
      title: `Public \`any\` in \`${sym.name}\` (${sym.file})`,
      description: `Exported function \`${sym.name}\` exposes \`any\` in its signature (${where.join(', ')}). Every caller silently loses type-safety on this boundary.`,
      evidence: [
        {
          file: sym.file,
          range: { startLine: sym.range.startLine, endLine: sym.range.endLine },
          snippet: sym.source.split('\n').slice(0, 4).join('\n'),
        },
      ],
      suggestion:
        'Replace `any` with the narrowest type that actually works (`unknown` + a type guard, a discriminated union, or a real interface). Prefer `unknown` over `any` when you only need "I do not know the shape yet".',
      fingerprint: `public-any:${stableHash(`${sym.file}:${sym.name}`)}`,
    });
  }
  return findings;
}

/**
 * True iff the rendered type includes a standalone `any` (not part of a
 * larger identifier like `Many`). Looks at top-level + nested generics.
 */
function containsAny(type: string): boolean {
  if (!type) return false;
  // Word-boundary match; excludes `Many`, `anyway`, `JsonAny` etc.
  return /\bany\b/.test(type);
}
