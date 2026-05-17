// Fixtures planted to exercise the RotHunter duplicate-type detector.
// DO NOT IMPORT FROM PRODUCTION CODE.

// --- Layer 1a strict TP: partner of dups-a.UserProfile (identical shape).
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

// --- Layer 1b structural TP: partner of dups-a.OrderRecord (same types, different names).
export interface InvoiceDocument {
  invoiceNumber: string;
  vendorEmail: string;
  total: number;
  settled: boolean;
  issuedAt: string;
}

// --- Layer 2 normalized-names TP: partner of dups-a.AccountSnakeCase
// (snake↔camel + uid→id synonym + mail→email synonym + created→createdAt).
export interface AccountCamelCase {
  uid: string;
  email: string;
  fullName: string;
  createdAt: string;
}

// --- Should NOT be reported (cross-domain, 3 strings, trivial shape).
export interface CountryCode {
  alpha2: string;
  alpha3: string;
  name: string;
}

// --- Should NOT be reported (no methods on Document — different shape from Processor).
export interface Document {
  id: string;
  name: string;
}
