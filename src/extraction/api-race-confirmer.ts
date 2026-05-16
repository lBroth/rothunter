import { z } from 'zod';
import { MlxLlmClient, createDefaultLlmClient } from '../adapters/mlx-llm.js';
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

export type ApiRaceVerdict = z.infer<typeof VerdictSchema>;

export interface ApiRaceCheckInput {
  method: string;
  pathPattern: string;
  /** Comma-separated client identifiers detected on the cluster. */
  clients: string;
  /** Up to 8 call sites with their enclosing function source slice. */
  sites: ReadonlyArray<{
    file: string;
    line: number;
    enclosingName?: string;
    enclosingSource: string;
  }>;
}

const PROMPT = `You are reviewing a static-analysis finding about a mutating HTTP call (PUT / PATCH / POST / DELETE) issued by multiple TypeScript functions from different files against the same URL pattern. Decide: is this a REAL cross-flow race (two independent flows can fire the write concurrently and the second overwrites the first) or SAFE (one of the callers is a test, all callers share a retry helper, the body is idempotent, or the writes use If-Match / ETag optimistic locking)?

Output ONE compact JSON object and STOP:
{"race": boolean, "confidence": <0..1>, "reason": "<max 22 words>"}

Decision rules (apply IN ORDER — first match wins):

1. **Test-only counterpart** — STRICT trigger: one caller's FILE PATH literally contains \`__tests__/\`, \`tests/\`, \`.test.ts\`, or \`.spec.ts\`, OR the function name begins with \`test_\` / \`it_\` / \`describe_\`. Mere fixture-style file names like \`case_*\` / \`*_a.ts\` / \`*_b.ts\` are NOT test markers. Suffixes like \`_web\` / \`_worker\` / \`_api\` / \`_cron\` are NOT test markers. → safe, confidence ≥ 0.85.

2. **Idempotent body** — every caller sends a CONSTANT or static value in the request body (\`{ status: 'active' }\`, \`{ enabled: true }\`, \`new Date()\`, \`{}\`). The value must NOT depend on a function parameter that callers fill in differently. → safe, confidence ≥ 0.85.

3. **Optimistic locking** — every caller sets an \`If-Match\` / \`If-Unmodified-Since\` / \`X-Resource-Version\` header (literal token \`If-Match\` or \`etag\` visible in the snippets of EVERY caller). → safe, confidence ≥ 0.8.

4. **Retry / single-flight wrapper** — STRICT trigger: one of the snippets contains a literal retry-helper definition (function whose name contains \`retry\`, \`backoff\`, \`withRetries\`, \`singleFlight\`) AND the other caller IMPORTS or CALLS that helper around the HTTP write. A mere caller name like \`*WithRetries\` is not enough on its own — the snippets must show the helper. → safe, confidence ≥ 0.75.

5. **Variable host (opaque upstream)** — the cluster path begins with \`/:param/\` (because the host portion of every URL in the snippets is itself a template variable, not a literal). In the snippets, EVERY URL is built by concatenating a host variable (commonly named \`baseUrl\`, \`this.baseUrl\`, \`apiUrl\`, \`endpoint\`, \`host\`, \`server\`) with the path. The actual upstream service is opaque to static analysis — two snippets may point at the SAME service (race) or at DIFFERENT services at runtime (safe). Common real-world case: two modules implementing OpenAI-compatible / vLLM clients against \`/chat/completions\` or \`/v1/embed\`, each parameterising the host via env-var / constructor. Without proof of host equality, treat as low-confidence race. → race: true, confidence 0.55. THIS RULE TAKES PRIORITY OVER RULE 6.

6. **Independent flows** — caller names or file basenames mention two unrelated owners. Common signal tokens: \`webhook\`, \`worker\`, \`cron\`, \`bot\`, \`consumer\`, \`browser\`, \`web\`, \`mobile\`, \`service\`, \`api\`, \`handler\`, \`scheduler\`, \`background\`. Body uses request-specific data that differs between flows, AND the path host is NOT a template variable. → race, confidence ≥ 0.85.

7. **Default** — mutating HTTP call from two distinct files, no idempotent body, no etag header in the snippets, no explicit test path, no variable host. → race, confidence ≥ 0.8.

8. Unclear → \`race: true, confidence: 0.6\`.

Strictness notes:
- Rule 1 ONLY fires when the file PATH contains a literal test marker (\`__tests__\`, \`tests/\`, \`.test.ts\`, \`.spec.ts\`). Fixture-style identifiers (\`case_01_*\`, \`_a.ts\`, \`_b.ts\`) and owner-style suffixes (\`_web\`, \`_worker\`, \`_api\`, \`_cron\`, \`_service\`) are NOT test markers — they ARE the independent-flow signal of rule 6.
- Rule 4 ONLY fires when a retry helper definition is actually visible in the supplied snippets. Do NOT assume a retry helper exists.
- For rule 2: the value is idempotent only if it is a constant or monotonic. Parameters passed into the caller (\`body\`, \`payload\`) make it NOT idempotent.
- Rule 5 catches a real-world FP class: two modules implementing OpenAI-compatible / vLLM-compatible / generic-HTTP API clients against \`/chat/completions\`, \`/v1/embed\`, etc., each parameterising the host via env-var or constructor. The path looks racy but the upstream service is opaque.

Cluster: \`{{METHOD}} {{PATH}}\` (clients: {{CLIENTS}})

Call sites:
\`\`\`
{{SITES}}
\`\`\`
`;

function renderSites(sites: ApiRaceCheckInput['sites']): string {
  return sites
    .map((s, i) => {
      const header = `[${i + 1}] ${s.file}:${s.line}${s.enclosingName ? ` — ${s.enclosingName}` : ''}`;
      return `${header}\n${s.enclosingSource}`;
    })
    .join('\n---\n');
}

export class ApiRaceConfirmer {
  private llm: MlxLlmClient;
  private cache = new Map<string, ApiRaceVerdict>();

  constructor(llm?: MlxLlmClient) {
    this.llm = llm ?? createDefaultLlmClient();
  }

  async confirm(input: ApiRaceCheckInput): Promise<ApiRaceVerdict | null> {
    const cacheKey = `${input.method} ${input.pathPattern}::${input.clients}::${input.sites
      .map((s) => `${s.file}:${s.line}`)
      .sort()
      .join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const sites = prepareSites(input.sites);
    const singleCallChars = estimatePromptChars(PROMPT, sites);
    let verdict: ApiRaceVerdict | null;
    if (singleCallChars <= PROMPT_BUDGET_CHARS) {
      verdict = await this.callOnce(input, sites);
    } else {
      verdict = await this.callChunked(input, sites);
    }
    if (verdict) this.cache.set(cacheKey, verdict);
    return verdict;
  }

  private async callOnce(
    input: ApiRaceCheckInput,
    sites: ClusterSite[],
  ): Promise<ApiRaceVerdict | null> {
    const prompt = PROMPT.replace('{{METHOD}}', input.method)
      .replace('{{PATH}}', input.pathPattern)
      .replace('{{CLIENTS}}', input.clients)
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
        { err: (err as Error).message, method: input.method, path: input.pathPattern },
        'ApiRaceConfirmer failed; returning null',
      );
      return null;
    }
  }

  private async callChunked(
    input: ApiRaceCheckInput,
    sites: ClusterSite[],
  ): Promise<ApiRaceVerdict | null> {
    const chunks = splitIntoChunks(sites);
    const chunkVerdicts: ApiRaceVerdict[] = [];
    for (const chunk of chunks) {
      const v = await this.callOnce(input, chunk);
      if (v) chunkVerdicts.push(v);
    }
    if (chunkVerdicts.length === 0) return null;
    return aggregateChunkVerdicts(chunkVerdicts);
  }
}
