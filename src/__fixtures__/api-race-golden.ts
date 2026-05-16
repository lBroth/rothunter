/**
 * Golden ground-truth verdicts for the api-race LLM confirmer.
 *
 * Each entry maps a clustered finding (identified by `<METHOD> <pathPattern>`)
 * to the expected LLM verdict. The eval harness scans every fixture file
 * under `__fixtures__/api-race/`, runs `detectApiRaces`, matches each cluster
 * to a golden entry, and compares the LLM verdict.
 *
 * DO NOT IMPORT FROM PRODUCTION CODE.
 */

export interface ApiRaceGolden {
  /** Short label for the eval table. */
  id: string;
  /** Cluster key from finding title — `<METHOD> <pathPattern>`, e.g. `PATCH /api/v1/profile/:param`. */
  cluster: string;
  /** Expected LLM verdict. */
  expected: 'race' | 'safe';
  /** Lower bound on |confidence| for a correct verdict to count. */
  min_confidence: number;
  /** Why this is the right verdict. */
  rationale: string;
}

export const API_RACE_GOLDEN: ApiRaceGolden[] = [
  // --- True positives -------------------------------------------------------
  {
    id: 'real/axios-patch-profile-web-vs-worker',
    cluster: 'PATCH /api/v1/profile/:param',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Web form + sync worker both PATCH the profile — last-write-wins across independent flows.',
  },
  {
    id: 'real/fetch-put-widget-browser-vs-service',
    cluster: 'PUT /widgets/:param',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Browser PUT + node-side service PUT to the same widget — concurrent overwrite.',
  },
  {
    id: 'real/got-post-webhook-forwarder',
    cluster: 'POST /forwarders/payment-webhook',
    expected: 'race',
    min_confidence: 0.75,
    rationale: 'Two webhook handlers (Stripe + PayPal) POST to the same forwarder concurrently.',
  },
  {
    id: 'real/axios-delete-resource-api-vs-cron',
    cluster: 'DELETE /api/resources/:param',
    expected: 'race',
    min_confidence: 0.75,
    rationale: 'User-facing API DELETE races with a cleanup cron deleting the same path.',
  },
  {
    id: 'real/ky-put-settings-user-vs-bulk',
    cluster: 'PUT /api/users/:param/settings',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Settings page PUT (single field) + bulk admin job PUT (all fields) — last-writer-wins overwrites the single-field caller.',
  },
  {
    id: 'real/axios-object-put-order',
    cluster: 'PUT /orders/:param',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Fulfillment service marks shipped while refund service marks refunded — directly conflicting writes.',
  },

  // --- False positives — LLM must clear -------------------------------------
  {
    id: 'safe/test-fixture-alongside-prod',
    cluster: 'PATCH /api/inventory/:param',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'One caller is a `test_*` function — unit test exercising prod path, not a concurrent flow.',
  },
  {
    id: 'safe/retry-wrapper',
    cluster: 'PUT /api/flags/:param',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Both call sites are part of the same retry / backoff helper — serialised, not concurrent.',
  },
  {
    id: 'safe/idempotent-put-set-active',
    cluster: 'PUT /subscriptions/:param/state',
    expected: 'safe',
    min_confidence: 0.75,
    rationale: 'Both writers set `status: "active"` — mathematically idempotent. Last-writer-wins is the intent.',
  },
  {
    id: 'safe/etag-optimistic-lock',
    cluster: 'PUT /docs/:param',
    expected: 'safe',
    min_confidence: 0.75,
    rationale: 'Both writers send `If-Match: <etag>` — server rejects stale writes with 412.',
  },
];
