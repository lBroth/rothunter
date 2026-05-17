export type SymbolKind = 'interface' | 'type-alias' | 'class' | 'enum' | 'function';

export interface FieldStructure {
  name: string;
  type: string;
  optional: boolean;
  readonly: boolean;
}

export interface TypeStructure {
  kind: 'object' | 'union' | 'intersection' | 'literal' | 'unknown';
  fields?: FieldStructure[];
  members?: TypeStructure[];
  raw?: string;
}

export interface FunctionStructure {
  kind: 'function';
  /** Parameters in declaration order. Reuses FieldStructure (name, type, optional). */
  params: FieldStructure[];
  /** TypeScript-rendered return type. */
  returnType: string;
  /** Whether the function is `async`. */
  async: boolean;
  /** Whether the function is a `*` generator. */
  generator: boolean;
  /** Raw body source including the braces, exactly as the user wrote it. */
  body: string;
  /**
   * Body after whitespace/comment collapse, used as the body-similarity hash
   * input. Local identifier renaming happens at the normalizer level so the
   * raw text here is still recognizable in evidence snippets.
   */
  bodyNormalized: string;
  /**
   * Token shingles (4-grams of identifier-anonymised tokens) used for the
   * near-duplicate Layer-4 pairwise Jaccard pass.
   */
  bodyShingles: ReadonlySet<string>;
}

export type AnyStructure = TypeStructure | FunctionStructure;

export interface SourceRange {
  startLine: number;
  endLine: number;
}

export interface SymbolRecord {
  id: string;
  kind: SymbolKind;
  name: string;
  file: string;
  /** Logical workspace name when running in multi-workspace mode. Undefined for single-workspace scans. */
  workspace?: string;
  range: SourceRange;
  source: string;
  exported: boolean;
  structure?: AnyStructure;

  // Filled by the normalizer
  hashStrict?: string;
  hashStructural?: string;
  hashNormalizedNames?: string;
  canonicalSignature?: string;

  // Reserved for the LLM extraction layer (week 2+)
  description?: string;
  domain?: string;
  embeddingSignature?: number[];
  embeddingSemantic?: number[];
}

export interface Evidence {
  file: string;
  range: SourceRange;
  snippet: string;
  note?: string;
}

export type Severity = 'low' | 'medium' | 'high';

export interface Finding {
  detectorId: string;
  severity: Severity;
  confidence: number;
  layer: 1 | 2 | 3;
  title: string;
  description: string;
  evidence: Evidence[];
  suggestion?: string;
  fingerprint: string;
}

export interface Detector {
  id: string;
  name: string;
  run(symbols: SymbolRecord[]): Promise<Finding[]>;
}
