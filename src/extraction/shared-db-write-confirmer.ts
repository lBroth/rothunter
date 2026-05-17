import { z } from 'zod';
import { MlxLlmClient } from '../adapters/mlx-llm.js';
import { parseLlmJsonResponse } from '../utils/llm-json.js';
import { logger } from '../utils/logger.js';
import {
  prepareSites,
  estimatePromptChars,
  splitIntoChunks,
  aggregateChunkVerdicts,
  PROMPT_BUDGET_CHARS,
  type ClusterSite,
} from './prompt-chunking.js';

const VerdictSchema = z.object({
  race: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type SharedDbVerdict = z.infer<typeof VerdictSchema>;

export interface SharedDbCheckInput {
  entity: string;
  column: string;
  /** ORM adapter mix detected on the cluster (e.g. `prisma+sequelize`). */
  adapters: string;
  /** Up to 8 call sites — each one is a small enclosing-function source slice. */
  sites: ReadonlyArray<{
    file: string;
    line: number;
    enclosingName?: string;
    enclosingSource: string;
  }>;
}

const PROMPT = `You are reviewing a static-analysis finding about a database column written by multiple TypeScript functions across different files. Decide: is this a REAL cross-flow race (two independent flows can concurrently overwrite the same column, producing a lost update) or SAFE (the writes are owned by one component, wrapped in a transaction, init-only, or idempotent)?

Output ONE compact JSON object and STOP:
{"race": boolean, "confidence": <0..1>, "reason": "<max 22 words>"}

Decision rules (apply IN ORDER — first match wins):

1. **Test-file callers** — STRICT trigger. Check each call-site header line (e.g. \`[1] src/foo/bar.ts:42 — myFn\`). At least one header must satisfy ONE of:
   - Path contains the literal substring \`__tests__/\`
   - Path contains the literal substring \`/tests/\`
   - Path ends in \`.test.ts\` or \`.test.tsx\`
   - Path ends in \`.spec.ts\` or \`.spec.tsx\`
   - Function name (after \`—\`) starts with \`test_\` / \`it_\` / \`describe_\`

   POSITIVE example — rule 1 fires:
       [1] src/users/users.service.ts:42 — createUser
       [2] tests/users.test.ts:18 — test_creates_user
   → safe (one caller is in tests/, function name is \`test_creates_user\`)

   NEGATIVE example — rule 1 does NOT fire (this is the dominant case):
       [1] src/rothunter/__fixtures__/shared-db/case_03_typeorm_status_api.ts:5 — markOrderPaidFromApi
       [2] src/rothunter/__fixtures__/shared-db/case_03_typeorm_status_consumer.ts:5 — refundOrderFromKafkaConsumer
   → NOT safe via rule 1. Paths contain \`__fixtures__\` which is NOT \`__tests__\` and NOT \`.test.ts\`. Owner suffixes \`_api\` / \`_consumer\` go to rule 7.

   NEGATIVE example #2 — rule 1 also does NOT fire on production paths:
       [1] src/api/users/handler.ts:12 — updateUserHandler
       [2] src/workers/sync.ts:34 — syncUserWorker
   → NOT safe via rule 1. Owner suffixes \`handler\` / \`worker\` go to rule 7.

   The substring check is LITERAL. \`__fixtures__\` is NOT \`__tests__\`. \`fixtures/\` is NOT \`tests/\`. \`case_*\` is NOT \`test_*\`.

   When this rule fires → safe, confidence ≥ 0.85.

2. **INSERT-only cluster** — every caller uses an INSERT method (\`.create(\` without \`upsert\`, \`.bulkCreate(\`, \`.insertMany(\`, \`.createMany(\`, \`INSERT INTO …\` raw SQL). INSERTs create NEW rows — concurrent inserts do not overwrite each other (a unique-constraint violation surfaces as an error, not a lost update). → safe, confidence ≥ 0.85. Caveat: if even ONE caller uses \`.update / .updateOne / .findOneAndUpdate / .upsert / .set\` the cluster is NOT insert-only.

3. **Idempotent / commutative value** — all writers assign \`new Date()\`, \`Date.now()\`, a monotonic clock, a boolean constant (\`true\`/\`false\`), or a literal that does not depend on the prior column value. No read of the column precedes the write. → safe, confidence ≥ 0.85. "Last writer wins" IS the intended semantics; concurrent writes lose no information.

4. **Per-tenant / per-plugin row isolation** — each caller targets a DIFFERENT row of the table identified by a constant key in the WHERE clause. Look for snippets where the filter object hard-codes a different value of the same key across callers, e.g. \`{ service: 'figma' }\` in figma.ts, \`{ service: 'gitlab' }\` in gitlab.ts, \`{ service: 'linear' }\` in linear.ts. Distinct rows = no overwrite race even when the same column is touched. Common shapes: OAuth plugin handlers, multi-tenant integrations, per-provider auth tables. → safe, confidence ≥ 0.8.

5. **Transaction-wrapped** — every writer is nested INSIDE the same outer \`$transaction(async (tx) => { ... })\` / \`unitOfWork.run(...)\` callback, OR every writer reads its \`tx\` from a single shared function parameter that is documented as the transaction handle (function name like \`applyXInsideTransaction*\` / \`*InTx\`). Caveat: simply passing \`{ transaction: tx }\` as an OPTION to a Sequelize/TypeORM call does NOT qualify — the caller can still invoke A and B from two independent flows. → safe, confidence ≥ 0.85.

6. **Same single-owner component** — all call sites are helpers inside the same service / module / class. Function names share a common prefix (e.g. \`FooService_step1\` + \`FooService_step2\`) or both files live under \`services/foo/\`. → safe, confidence ≥ 0.8.

7. **Init-only / one-shot scripts** — all writers are bootstrap / seed / migration / backfill / one-shot import scripts. Function names contain \`seed\`, \`import\`, \`backfill\`, \`migrate\`. → safe, confidence ≥ 0.8.

8. **Independent flows** — names / paths show two unrelated owners (HTTP handler + worker, two webhook handlers, API + cron, GraphQL mutation + bot, checkout + sync worker) writing the SAME column via UPDATE-style methods. The written value depends on prior state or external input (no idempotency). → race, confidence ≥ 0.85.

9. **Default** — UPDATE-style ORM write (\`.update / .upsert / .updateOne / .findOneAndUpdate / .set\`) with no transaction, no shared owner, no idempotency. → race, confidence ≥ 0.8.

10. Unclear → \`race: true, confidence: 0.6\`. Preserve the deterministic finding at low confidence.

Notes:
- Rule 1 has top priority. If ANY snippet is from a test file, the cluster is safe — tests do not race with production.
- Rule 2: INSERT methods create new rows and cannot lose information across concurrent callers. UPDATE methods overwrite an existing row's column and CAN lose information. The distinction is critical — most Sequelize/Mongoose codebases have many \`Model.create(...)\` cross-file calls (factories, lifecycle hooks, test fixtures) that the deterministic detector clusters together. They are not races.
- Rule 3 takes priority over rules 5 and 7. An audit-trail \`lastSeenAt = new Date()\` written by an HTTP handler AND a background ping is **safe** — both writers compute the same kind of value.
- Rule 4 takes priority over rule 7. Two flows sharing a transaction are safe even if they look independent.
- For rule 7: examine function and file names — \`handler\`, \`webhook\`, \`cron\`, \`worker\`, \`consumer\`, \`bot\`, \`api\`, \`route\` are independent-flow signals.

Cluster: \`{{ENTITY}}.{{COLUMN}}\` (adapters: {{ADAPTERS}})

Call sites:
\`\`\`
{{SITES}}
\`\`\`
`;

function renderSites(sites: SharedDbCheckInput['sites']): string {
  return sites
    .map((s, i) => {
      const header = `[${i + 1}] ${s.file}:${s.line}${s.enclosingName ? ` — ${s.enclosingName}` : ''}`;
      return `${header}\n${s.enclosingSource}`;
    })
    .join('\n---\n');
}

export class SharedDbWriteConfirmer {
  private llm: MlxLlmClient;
  private cache = new Map<string, SharedDbVerdict>();

  constructor(llm?: MlxLlmClient) {
    this.llm = llm ?? new MlxLlmClient();
  }

  async confirm(input: SharedDbCheckInput): Promise<SharedDbVerdict | null> {
    const cacheKey = `${input.entity}.${input.column}::${input.adapters}::${input.sites
      .map((s) => `${s.file}:${s.line}`)
      .join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const sites = prepareSites(input.sites);

    // If even the truncated single-call prompt exceeds the context budget,
    // split the sites into chunks and aggregate verdicts.
    const singleCallChars = estimatePromptChars(PROMPT, sites);
    let verdict: SharedDbVerdict | null;
    if (singleCallChars <= PROMPT_BUDGET_CHARS) {
      verdict = await this.callOnce(input, sites);
    } else {
      verdict = await this.callChunked(input, sites);
    }
    if (verdict) this.cache.set(cacheKey, verdict);
    return verdict;
  }

  private async callOnce(
    input: SharedDbCheckInput,
    sites: ClusterSite[],
  ): Promise<SharedDbVerdict | null> {
    const prompt = PROMPT.replace('{{ENTITY}}', input.entity)
      .replace('{{COLUMN}}', input.column)
      .replace('{{ADAPTERS}}', input.adapters)
      .replace('{{SITES}}', renderSites(sites));
    try {
      const raw = await this.llm.chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0, maxTokens: 128 },
      );
      const parsed = parseLlmJsonResponse(raw);
      return VerdictSchema.parse(parsed);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, entity: input.entity, column: input.column },
        'SharedDbWriteConfirmer failed; returning null',
      );
      return null;
    }
  }

  private async callChunked(
    input: SharedDbCheckInput,
    sites: ClusterSite[],
  ): Promise<SharedDbVerdict | null> {
    const chunks = splitIntoChunks(sites);
    const chunkVerdicts: SharedDbVerdict[] = [];
    for (const chunk of chunks) {
      const v = await this.callOnce(input, chunk);
      if (v) chunkVerdicts.push(v);
    }
    if (chunkVerdicts.length === 0) return null;
    return aggregateChunkVerdicts(chunkVerdicts);
  }
}
