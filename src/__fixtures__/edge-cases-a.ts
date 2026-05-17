// Adversarial fixtures — RotHunter duplicate-type detector hard cases.
// DO NOT IMPORT FROM PRODUCTION CODE.
// Each block annotates the expected detector behavior. Partners live in edge-cases-b.ts.

// ============================================================================
// TPs — must be reported
// ============================================================================

// --- T1 strict: method signature parity (regression guard for parser fix).
export interface T1_Runnable {
  id: string;
  name: string;
  run(input: string, options?: Record<string, unknown>): Promise<string>;
}

// --- T2 strict: generic instantiation must hash stably across files.
export interface T2_Wrapper {
  value: Promise<{ items: Array<{ id: string; tags: ReadonlyArray<string> }> }>;
  meta: Map<string, number>;
}

// --- T3 strict: heavy whitespace / formatting differences must collapse to the same signature.
// (Partner in dups-b deliberately uses tight, alphabetized formatting.)
export interface T3_FormattingNoise {
  alpha:    string;
  beta:    number;
  gamma:    boolean;
}

// --- T4 structural: 5 fields, mixed primitives across 3 kinds — must pass the trivial filter.
export interface T4_TransferRecord {
  reference: string;
  amount: number;
  settled: boolean;
  retries: number;
  bookedAt: string;
}

// --- T5 structural: contains a complex (Date) field — passes trivial filter via `complex` kind.
export interface T5_AuditEvent {
  actor: string;
  occurredAt: Date;
  action: string;
  reverted: boolean;
}

// --- T6 normalized: full synonym chain (uid+mail+fullname+displayname+createdon).
export interface T6_ProfileSnake {
  uid: string;
  mail: string;
  full_name: string;
  display_name: string;
  created_on: string;
}

// --- T7 normalized: kebab-case → camelCase normalization path.
// Note: snake/kebab normalizer treats `[_-]` identically, so kebab-cased keys
// hash the same as their camelCase partner.
export interface T7_KebabConfig {
  'max-retries': number;
  'base-url': string;
  'enable-cache': boolean;
  'timeout-ms': number;
}

// --- T8 normalized: leading underscore stripping (`_id` → `id`).
export interface T8_LegacyEntity {
  _id: string;
  _email: string;
  _full_name: string;
  _created_on: string;
}

// ============================================================================
// Regression guards — MUST NOT be reported (paired with negatives in edge-cases-b)
// ============================================================================

// --- N1 strict: optional modifier must break strict equivalence.
export interface N1_StrictOptionalDifferA {
  id: string;
  email: string;
  nickname?: string;
}

// --- N2 strict: method signature must differ when parameter types differ.
export interface N2_MethodSigDifferA {
  id: string;
  process(input: string): Promise<string>;
}

// --- N3 structural: 4 strings, monotype primitive — trivial filter must block.
export interface N3_MonotypeStringsA {
  street: string;
  city: string;
  zip: string;
  country: string;
}

// --- N4 structural: only 3 fields — below STRUCTURAL_MIN_FIELDS (4).
export interface N4_TooFewFieldsA {
  x: number;
  y: number;
  label: string;
}

// --- N5 structural: 5 fields but two interfaces should still NOT match
// because their TYPES diverge by one field (boolean vs string at position 3).
export interface N5_TypeDivergesA {
  reference: string;
  amount: number;
  active: boolean;
  retries: number;
  bookedAt: string;
}

// --- N6 strict: index signature vs a single property of same value type — must NOT collide.
export interface N6_IndexSigA {
  [bucket: string]: number;
}

// --- L1 border: `{id, name}` strict triple across unrelated domains — Layer 3 LLM should reject.
// (Adds Catalog here so Template/RegistryAuth/Document/Catalog form a 4-way cluster.)
export interface L1_Catalog {
  id: string;
  name: string;
}

// --- Hard set additions (golden eval pairs 9-12) ---

// G9 different/color-vs-point: same {number×3} but distinct domains.
export interface G9_RGBColor {
  r: number;
  g: number;
  b: number;
}

// G10 different/large-but-unrelated: 5 numeric fields, structural collision, distinct semantics.
export interface G10_AudioMixerChannel {
  gain: number;
  pan: number;
  mute: number;
  solo: number;
  fader: number;
}

// G11 same/optional-vs-required: same fields, one optional modifier differs.
// (Strict hash diverges; LLM should still call them same concept.)
export interface G11_UserPrefsOptional {
  theme?: string;
  language: string;
  notifications: boolean;
  fontSize: number;
}

// G12 same/with-method-different-name: parser captures both methods,
// strict hash diverges; LLM must recognise it's the same handler concept.
export interface G12_RequestHandler {
  id: string;
  pattern: string;
  handle(req: string): Promise<string>;
}

// G13 same/nested-object: nested object literal with synonym field name on the outer level.
export interface G13_AccountWithSettingsA {
  userId: string;
  email: string;
  settings: { theme: string; language: string; notifications: boolean };
}

// G14 same/acronym-mismatch: same field semantics under different casing convention.
export interface G14_HttpRequestA {
  URL: string;
  HTTPMethod: string;
  bodyJSON: string;
}

// G15 same/type-alias-vs-interface (a side is interface, b side is type alias).
export interface G15_RectangleA {
  width: number;
  height: number;
  fill: string;
}

// G16 same/date-vs-timestamp: same temporal concept, different runtime representation.
export interface G16_DeploymentEventA {
  service: string;
  version: string;
  occurredAt: Date;
  durationMs: number;
}

// G17 same/recursive-self-reference: classic linked-list node, renamed type.
export interface G17_LinkedNodeA {
  value: string;
  next: G17_LinkedNodeA | null;
}

// G18 different/trojan-similar-name: same shape, scope differs (single entity vs audit-log row).
export interface G18_OrderA {
  orderId: string;
  total: number;
  paid: boolean;
}

// G19 same/literal-vs-string-widening: same field semantics, B is a stricter union.
export interface G19_TaskStatusA {
  id: string;
  status: string;
  retries: number;
}

// G20 different/generic-vs-specialized: parametric container vs domain-specific list.
export interface G20_ContainerA<T> {
  items: T[];
  capacity: number;
}
