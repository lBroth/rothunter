// Adversarial fixtures — partners of edge-cases-a.ts.
// DO NOT IMPORT FROM PRODUCTION CODE.

// ============================================================================
// TPs — partners
// ============================================================================

// --- T1 strict partner.
export interface T1_Worker {
  id: string;
  name: string;
  run(input: string, options?: Record<string, unknown>): Promise<string>;
}

// --- T2 strict partner.
export interface T2_Envelope {
  value: Promise<{ items: Array<{ id: string; tags: ReadonlyArray<string> }> }>;
  meta: Map<string, number>;
}

// --- T3 strict partner (tight formatting, identical shape).
export interface T3_TightlyFormatted {
  alpha: string;
  beta: number;
  gamma: boolean;
}

// --- T4 structural partner (same primitive layout, all different names).
export interface T4_InvoiceLine {
  description: string;
  total: number;
  paid: boolean;
  attempts: number;
  issuedAt: string;
}

// --- T5 structural partner (Date keeps the shape non-trivial).
export interface T5_ChangeLog {
  author: string;
  timestamp: Date;
  operation: string;
  rolledBack: boolean;
}

// --- T6 normalized partner (camelCase + synonym targets).
export interface T6_ProfileCamel {
  id: string;
  email: string;
  name: string;
  displayName: string;
  createdAt: string;
}

// --- T7 normalized partner: same fields as kebab-case sibling, in camelCase.
export interface T7_CamelConfig {
  maxRetries: number;
  baseUrl: string;
  enableCache: boolean;
  timeoutMs: number;
}

// --- T8 normalized partner: clean camelCase against leading-underscore sibling.
export interface T8_FreshEntity {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
}

// ============================================================================
// Regression guards — partners
// ============================================================================

// --- N1 partner: same fields but `nickname` is required.
export interface N1_StrictOptionalDifferB {
  id: string;
  email: string;
  nickname: string;
}

// --- N2 partner: same method name, parameter type differs.
export interface N2_MethodSigDifferB {
  id: string;
  process(input: number): Promise<string>;
}

// --- N3 partner: another 4-string interface in an unrelated domain.
export interface N3_MonotypeStringsB {
  host: string;
  region: string;
  env: string;
  cluster: string;
}

// --- N4 partner: 3 fields, also too few to be considered structural.
export interface N4_TooFewFieldsB {
  startMs: number;
  endMs: number;
  reason: string;
}

// --- N5 partner: position 3 is string instead of boolean (forces hash divergence).
export interface N5_TypeDivergesB {
  reference: string;
  amount: number;
  status: string;
  retries: number;
  bookedAt: string;
}

// --- N6 partner: a real property with the same value type — must not collide with index sig.
export interface N6_PropOnly {
  count: number;
}

// --- G9 different partner: {number×3} but distinct semantics (point vs color).
export interface G9_Point3D {
  x: number;
  y: number;
  z: number;
}

// --- G10 different partner: 5-numeric fields, structural collision, distinct semantics.
export interface G10_VideoEncoderProfile {
  bitrate: number;
  fps: number;
  width: number;
  height: number;
  keyframeIntervalMs: number;
}

// --- G11 same partner: all fields required (LLM should still match).
export interface G11_UserPrefsRequired {
  theme: string;
  language: string;
  notifications: boolean;
  fontSize: number;
}

// --- G12 same partner: different method name but same concept (HTTP request handler).
export interface G12_RouteHandler {
  id: string;
  pattern: string;
  serve(req: string): Promise<string>;
}

// --- G13 same partner: nested object with synonym outer field name.
export interface G13_AccountWithPreferencesB {
  uid: string;
  email: string;
  preferences: { theme: string; language: string; notifications: boolean };
}

// --- G14 same partner: camelCase variant of the same HTTP request concept.
export interface G14_HttpRequestB {
  url: string;
  httpMethod: string;
  bodyJson: string;
}

// --- G15 same partner: type alias of identical shape (interface vs type-alias).
export type G15_RectangleB = {
  width: number;
  height: number;
  fill: string;
};

// --- G16 same partner: timestamp stored as epoch millis instead of Date.
export interface G16_DeploymentEventB {
  service: string;
  version: string;
  occurredAt: number;
  durationMs: number;
}

// --- G17 same partner: linked-list node with renamed type, self-referential.
export interface G17_LinkedItemB {
  value: string;
  next: G17_LinkedItemB | null;
}

// --- G18 different partner: audit-log row, same field set but represents a history record.
export interface G18_OrderHistoryEntryB {
  orderId: string;
  total: number;
  paid: boolean;
}

// --- G19 same partner: status as a literal union (stricter), same concept.
export interface G19_TaskStateB {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  retries: number;
}

// --- G20 different partner: domain-specific specialised list — same field types but not generic.
export interface G20_StringListB {
  items: string[];
  capacity: number;
}
