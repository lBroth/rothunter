import { z } from 'zod';
import { LlmClient, createDefaultLlmClient } from '../adapters/llm.js';
import { parseLlmJsonResponse } from '../utils/llm-json.js';
import { logger } from '../utils/logger.js';

const VerdictSchema = z.object({
  race: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type RaceVerdict = z.infer<typeof VerdictSchema>;

export interface RaceCheckInput {
  file: string;
  line: number;
  /** Detection pattern: read-modify-write | promise-all | emitter-handler. */
  pattern: 'read-modify-write' | 'promise-all' | 'emitter-handler';
  /** Canonical shared target (e.g. `this.tally`, `userCache`). */
  target: string;
  /** Surrounding function source — trimmed to ≤ 42 lines by the detector. */
  enclosingSource: string;
  /** Optional function or method name for context. */
  enclosingName?: string;
}

const PROMPT = `You are reviewing a TypeScript race-condition finding from a static analyzer. Decide: is this a REAL race (two concurrent callers can produce a lost update / corrupted state) or SAFE (the apparent race is neutralised by scope, mutex, idempotency, or single-flight)?

Output ONE compact JSON object and STOP:
{"race": boolean, "confidence": <0..1>, "reason": "<max 18 words>"}

Calibration:
- Unambiguous classic race (\`this.<field>\` or module-scope \`let\`/\`var\` with read → await → write back, no mutex, no guard, no idempotency) → confidence ≥ 0.85.
- \`Promise.all\` siblings both writing the same \`this.<field>\` or module mutable → confidence ≥ 0.9 (no timing window required).
- Unambiguous safe pattern (function-local \`let\` / mutex-wrapped / single-flight guard / distinct read+write targets / idempotent constant assignment) → confidence ≥ 0.85.
- Genuinely unclear → \`race: true, confidence: 0.6\` (keep the deterministic finding at low confidence).

Decision rules (apply in order):
1. Shared target is a FUNCTION-LOCAL \`let\`/\`var\` declared inside the same function (not a parameter, not module-scope, not \`this.<field>\`) — safe. Per-caller copy; no concurrent sharing.
2. Write assigns a constant / boolean literal and no later read depends on the value — safe. Idempotent.
3. Critical section wrapped in a mutex / lock / single-flight (\`await acquire()\` / \`mutex.lock()\` / guard \`if (this.X !== null) return this.X\` before the first await) — safe.
4. Read target and write target differ (e.g. read \`this.raw\`, write \`this.parsed\`) — safe. No lost-update.
5. Pattern is \`promise-all\` but callback only reads shared state — safe.
6. Otherwise: \`this.<field>\` or module-scope mutable + read → await → write back to the same target → race.

Pattern: {{PATTERN}}
Shared target: \`{{TARGET}}\`
{{ENCLOSING_NAME_LINE}}

Enclosing function ({{FILE}}:{{LINE}}):
\`\`\`typescript
{{ENCLOSING}}
\`\`\`
`;

export class RaceConfirmer {
  private llm: LlmClient;
  private cache = new Map<string, RaceVerdict>();

  constructor(llm?: LlmClient) {
    this.llm = llm ?? createDefaultLlmClient();
  }

  async confirm(input: RaceCheckInput): Promise<RaceVerdict | null> {
    const cacheKey = `${input.file}:${input.line}:${input.pattern}:${input.target}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const prompt = PROMPT.replace('{{PATTERN}}', input.pattern)
      .replace('{{TARGET}}', input.target)
      .replace(
        '{{ENCLOSING_NAME_LINE}}',
        input.enclosingName ? `Enclosing identifier: \`${input.enclosingName}\`` : '',
      )
      .replace('{{FILE}}', input.file)
      .replace('{{LINE}}', String(input.line))
      .replace('{{ENCLOSING}}', input.enclosingSource);

    try {
      const raw = await this.llm.chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0, maxTokens: 96 },
      );
      const parsed = parseLlmJsonResponse(raw);
      const verdict = VerdictSchema.parse(parsed);
      this.cache.set(cacheKey, verdict);
      return verdict;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, file: input.file, line: input.line },
        'RaceConfirmer failed; returning null',
      );
      return null;
    }
  }
}
