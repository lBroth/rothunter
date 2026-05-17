// Fixtures planted to exercise the RotHunter duplicate-type detector.
// DO NOT IMPORT FROM PRODUCTION CODE.

// --- Layer 1a strict TP: identical shape, identical names, identical types
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

// --- Layer 1b structural TP: same 5 field types, different field names,
// mixed primitives (must survive the trivial-shape filter).
export interface OrderRecord {
  orderId: string;
  customerEmail: string;
  amount: number;
  paid: boolean;
  placedAt: string;
}

// --- Layer 2 normalized-names TP candidate (snake_case partner lives in dups-b.ts).
export interface AccountSnakeCase {
  user_id: string;
  mail: string;
  full_name: string;
  created_on: string;
}

// --- Should NOT be reported (3 strings, trivial shape).
export interface DnsRecord {
  host: string;
  zone: string;
  ttl: string;
}

// --- Method-bearing interface; must NOT collide with prop-only interfaces sharing
// the same property names elsewhere (regression guard for the parser fix).
export interface Processor {
  id: string;
  name: string;
  process(input: string): Promise<string>;
}
