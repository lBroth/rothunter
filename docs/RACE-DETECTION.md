# Cross-service race detection

rothunter catches three shapes of race condition that traditional
linters and SonarQube-class scanners cannot see, because the
race spans repository / service / database boundaries:

| #   | Shape                                                              | Detector          | Severity |
| --- | ------------------------------------------------------------------ | ----------------- | -------- |
| 1   | Two services writing the same DB column with no coordination       | `shared-db-write` | HIGH     |
| 2   | Two services calling the same write-endpoint with no version check | `api-race`        | HIGH     |
| 3   | Async fan-out where the same endpoint is hit by sibling services   | `api-race`        | HIGH     |

The walkthrough below uses a 7-package monorepo (`packages/*`) wired
together by HTTP fetches. Boot the engine with `npm run dev:full`,
point the dashboard at the monorepo root, and trigger a scan — every
finding below shows up in the open list.

---

## Scenario 1 — direct DB writers across services

`billing-service` writes `user.tier` from a Stripe webhook:

```ts
// packages/billing-service/src/index.ts
await prisma.user.update({
  where: { id: payload.userId },
  data: { tier, billingUpdatedAt: new Date() },
});
```

`account-service` writes the same column from an HTTP endpoint:

```ts
// packages/account-service/src/index.ts
await prisma.user.update({
  where: { id },
  data: { tier: body.tier, lastTierSource: body.source },
});
```

Two services, same column, no optimistic-locking version check.

**rothunter output:**

```
shared-db-write · HIGH
Shared DB column write: `user.tier` across 2 files (2 call sites, adapters: prisma)
files: [account-service/src/index.ts, billing-service/src/index.ts]
```

---

## Scenario 2 — same write-endpoint, multiple async callers

`admin-service` lets support engineers override a user's tier:

```ts
// packages/admin-service/src/index.ts
await fetch(`http://account-service:3000/api/users/${userId}/tier`, {
  method: 'PATCH',
  body: JSON.stringify({ tier, source: `admin:${ticketId}` }),
});
```

`promo-service` applies a redeemed promo three seconds later:

```ts
// packages/promo-service/src/index.ts
setTimeout(() => {
  void fetch(`http://account-service:3000/api/users/${userId}/tier`, {
    method: 'PATCH',
    body: JSON.stringify({ tier, source: 'promo' }),
  });
}, 3_000);
```

Two callers, same `PATCH /api/users/:id/tier`, no `If-Match`, no
single-flight guard. Order of arrival decides the persisted tier.

**rothunter output:**

```
api-race · HIGH
Shared API write: `PATCH /api/users/:param/tier` called from 2 files (2 call sites, clients: fetch)
files: [admin-service/src/index.ts, promo-service/src/index.ts]
```

---

## Scenario 3 — single DB writer, fan-out callers

`orderer-service` fans an order out across the system without
awaiting anything:

```ts
// packages/orderer-service/src/index.ts
void fetch(`http://inventory-service:3000/api/inventory/${sku}`, {
  method: 'PUT',
  body: JSON.stringify({ quantity: qty, source: `orderer:${orderId}` }),
});
void fetch(`http://notifier-service:3000/api/notify/order-placed`, ...);
```

`notifier-service` reacts to the same event and PUTs inventory for
its forecast cache:

```ts
// packages/notifier-service/src/index.ts
await fetch(`http://inventory-service:3000/api/inventory/${sku}`, {
  method: 'PUT',
  body: JSON.stringify({ quantity: forecastQty, source: `notifier:${orderId}` }),
});
```

`inventory-service` is the only service that touches the DB column
— so `shared-db-write` stays silent (only one writer). But two
sibling services hit the same `PUT /api/inventory/:id` endpoint
asynchronously, and `api-race` catches that:

**rothunter output:**

```
api-race · HIGH
Shared API write: `PUT /api/inventory/:param` called from 2 files (2 call sites, clients: fetch)
files: [notifier-service/src/index.ts, orderer-service/src/index.ts]
```

---

## Why other scanners miss these

ESLint / Biome / TSLint walk one file at a time. SonarQube walks a
single repository at a time. The race in every scenario above lives
between repositories, so a single-repo scan cannot see it.

rothunter's monorepo + multi-workspace mode parses every linked
package into one symbol graph, then runs `shared-db-write` and
`api-race` cross-workspace — the only place the race is visible.
The LLM verdict pass then drops obvious false positives (single-
owner writes wrapped in a transaction, queue-serialised handlers,
…) so the surfaced findings are the actionable ones.
