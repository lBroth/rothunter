// Function duplicate fixtures — partners of functions-a.ts.

// F1 strict partner: identical body, same parameter names + types.
export function formatPriceB(value: number, currency: string): string {
  if (value < 0) return `-${currency}${(-value).toFixed(2)}`;
  return `${currency}${value.toFixed(2)}`;
}

// F2 normalized partner: camelCase parameter names.
export function processOrderB(orderId: string, itemCount: number): boolean {
  const result = orderId.length > 0 && itemCount > 0;
  return result;
}

// F3 structural partner: identical control-flow skeleton, different identifiers.
export async function pushToStorage(folder: string, blob: Buffer): Promise<string> {
  const handle = makeKey(folder);
  const digest = hashBytes(blob);
  if (!handle || !digest) {
    throw new Error('failed to derive key/checksum');
  }
  await transmit(handle, blob, digest);
  return handle;
}

// F4 strict partner: same body, exact match for clampInt.
export function clampInteger(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return Math.floor(value);
}

// FN1 partner: another trivial 1-line function (also filtered).
export function getCode(): string {
  return 'b';
}

// FN2 partner: same skeleton but parameters are strings → different concept.
export function addStrings(a: string, b: string): string {
  const sum = a + b;
  return sum;
}

// FN3 partner: same signature as applyTaxA but body computes discount instead.
export function applyDiscountB(amount: number, rate: number): number {
  return amount * (1 - rate);
}

// Helpers used in fixture bodies.
function makeKey(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

function hashBytes(data: Buffer): string {
  return `${data.length}`;
}

async function transmit(_handle: string, _blob: Buffer, _digest: string): Promise<void> {
  return Promise.resolve();
}
