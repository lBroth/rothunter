// Function duplicate fixtures — RotHunter duplicate-function detector hard cases.
// DO NOT IMPORT FROM PRODUCTION CODE. Partners live in functions-b.ts.

// ============================================================================
// TPs — must be reported
// ============================================================================

// F1 strict: identical signature + identical body.
export function formatPriceA(value: number, currency: string): string {
  if (value < 0) return `-${currency}${(-value).toFixed(2)}`;
  return `${currency}${value.toFixed(2)}`;
}

// F2 normalized-names: snake↔camel parameter names; same body shape under rename.
export function processOrderA(order_id: string, item_count: number): boolean {
  const result = order_id.length > 0 && item_count > 0;
  return result;
}

// F3 structural: same skeleton, identifiers anonymised.
// (Partner uses completely different local + param names but same control flow.)
export async function uploadToBucket(bucketName: string, payload: Buffer): Promise<string> {
  const key = generateKey(bucketName);
  const checksum = computeChecksum(payload);
  if (!key || !checksum) {
    throw new Error('failed to derive key/checksum');
  }
  await sendToCloud(key, payload, checksum);
  return key;
}

// F4 strict: 4-line body that should match exactly.
export function clampInt(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return Math.floor(value);
}

// ============================================================================
// Regression guards — MUST NOT be reported
// ============================================================================

// FN1 strict: trivial body, too short to mean anything (filter must skip).
export function getName(): string {
  return 'a';
}

// FN2 structural: same skeleton but different parameter types → different concept.
export function addNumeric(a: number, b: number): number {
  const sum = a + b;
  return sum;
}

// FN3 strict: signature matches a partner but body diverges meaningfully.
export function applyTaxA(amount: number, rate: number): number {
  return amount * (1 + rate);
}

// Helpers used in fixture bodies — keep them realistic.
function generateKey(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

function computeChecksum(data: Buffer): string {
  return `${data.length}`;
}

async function sendToCloud(_key: string, _payload: Buffer, _checksum: string): Promise<void> {
  return Promise.resolve();
}
