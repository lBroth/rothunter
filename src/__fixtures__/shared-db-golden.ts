/**
 * Golden ground-truth verdicts for the shared-db-write LLM confirmer.
 *
 * Each entry maps a clustered finding (identified by `<entity>.<column>`)
 * to the expected LLM verdict. The eval harness scans every fixture
 * file under `__fixtures__/shared-db/`, runs the deterministic
 * `detectSharedDbWrites` clusterer, then runs the LLM confirmer
 * on each finding and compares against the expected verdict.
 *
 * DO NOT IMPORT FROM PRODUCTION CODE.
 */

export interface SharedDbGolden {
  /** Short label for the eval table. */
  id: string;
  /** Lower-cased entity + column from the finding title, e.g. `useremail.email`. */
  cluster: string;
  /** Expected LLM verdict. */
  expected: 'race' | 'safe';
  /** Lower bound on |confidence| for a correct verdict to count. */
  min_confidence: number;
  /** Why this is the right verdict — for humans reading the eval report. */
  rationale: string;
}

export const SHARED_DB_GOLDEN: SharedDbGolden[] = [
  // --- True positives -------------------------------------------------------
  {
    id: 'real/prisma-email-cross-service',
    cluster: 'useremail.email',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'HTTP handler + sync worker both write `userEmail.email`. Last write wins across independent flows.',
  },
  {
    id: 'real/sequelize-counter-webhooks',
    cluster: 'signupcounter.value',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Two independent webhook handlers upsert `signupCounter.value` — classic distributed counter race.',
  },
  {
    id: 'real/typeorm-order-status',
    cluster: 'paidorder.status',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'HTTP API marks `paid` while Kafka consumer marks `refunded` on the same row.',
  },
  {
    id: 'real/mongoose-displayname',
    cluster: 'profile.displayName',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'GraphQL mutation and Slack-bot reaction both rename `Profile.displayName` — concurrent overwrites possible.',
  },
  {
    id: 'real/drizzle-stock',
    cluster: 'stocktable.quantity',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Checkout flow and inventory worker both overwrite `stockTable.quantity`. Lost decrement risk.',
  },
  {
    id: 'real/raw-sql-balance',
    cluster: 'walletaccount.balance',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Webhook + nightly cron both overwrite `walletAccount.balance` — read-modify-write semantics demanded by money.',
  },

  // --- False positives — LLM must clear -------------------------------------
  {
    id: 'safe/same-service-helpers',
    cluster: 'registrationdraft.regEmail',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Both helpers are `RegistrationService_*` — single-owner service. No cross-service concurrency surface.',
  },
  {
    id: 'safe/init-only-seed-vs-import',
    cluster: 'productcatalogentry.sku',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Both writers are one-shot bootstrap scripts (seed + CSV import). Temporally disjoint, no concurrent surface.',
  },
  {
    id: 'safe/idempotent-timestamp',
    cluster: 'audittrail.lastSeenAt',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Both writers set `lastSeenAt` to `new Date()` — last-writer-wins is the intended semantics, no information lost.',
  },
  {
    id: 'safe/wrapped-in-transaction',
    cluster: 'taxline.amount',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Both writes accept a `tx` parameter — caller runs them inside one Prisma $transaction. Atomic.',
  },
  {
    id: 'safe/test-file-alongside-prod',
    cluster: 'profile.email',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'One caller lives in a `.test.ts` file — unit test exercising production write, not a concurrent flow.',
  },
  {
    id: 'safe/insert-only-cluster',
    cluster: 'auditlog.userId',
    expected: 'safe',
    min_confidence: 0.75,
    rationale: 'Every caller uses `Model.create(...)` — INSERT creates a new row, no overwrite race possible.',
  },
  {
    id: 'safe/per-plugin-row-isolation',
    cluster: 'plugintoken.refreshToken',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Two OAuth callback handlers (figma vs gitlab) update the same column but target DIFFERENT rows via a constant service key — no shared row, no race.',
  },
];
