import { z } from 'zod';
import { MlxLlmClient } from '../adapters/mlx-llm.js';
import { parseLlmJsonResponse } from '../utils/llm-json.js';
import { logger } from '../utils/logger.js';

const VerdictSchema = z.object({
  intentional: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type MutationVerdict = z.infer<typeof VerdictSchema>;

export interface MutationCheckInput {
  file: string;
  line: number;
  /** Free-text pattern label: 'array-mutator' / 'object-assign' / etc. */
  pattern: string;
  /** Whether the deterministic layer detected escape. */
  escapes: boolean;
  /** The flagged mutation code (e.g. `record.tag = tag`). */
  snippet: string;
  /** Surrounding function source, trimmed to a few lines around the mutation. */
  enclosingSource: string;
  /** Optional function or method name for context. */
  enclosingName?: string;
}

const PROMPT = `You are reviewing a TypeScript mutation that a static analyzer flagged. Decide: is this mutation INTENTIONAL (builder pattern, accumulator, documented in-place transform, framework-required convention) or a BUG (accidental shared-state corruption / surprise side effect)?

Output ONE compact JSON object and STOP:
{"intentional": boolean, "confidence": <0..1>, "reason": "<max 15 words>"}

Decision rules (apply in order):
1. Accumulator / builder pattern. Function name contains build/collect/accumulate/append; or parameter name is one of \`out\`, \`acc\`, \`result\`, \`into\`, \`buf\` — intentional, confidence ≥ 0.85.
2. Framework convention: Fastify/Express \`req.<prop> = value\` to decorate the request, NestJS interceptors, JSX prop spread builders — intentional, confidence ≥ 0.8.
3. In-place transform whose name signals mutation: \`mutate\`, \`update\`, \`assign\`, \`patch\`, \`apply\`, \`reset\`, \`init\`, \`load\` — intentional, confidence ≥ 0.8.
4. Escapes via return AND function name sounds pure (compute*, calc*, derive*, format*, transform*, build*Pure) — bug, confidence ≥ 0.8.
5. delete on an arg that looks like a DTO returned to a caller — bug.
6. Module-scope state write (\`shared-state-write\` pattern) outside a class boundary — borderline; mark intentional only if there is a clear init/setup function name.
7. When genuinely unclear → \`intentional: false, confidence: 0.5\` (the deterministic finding stays at the original severity).

Pattern: {{PATTERN}}{{ESCAPE_TAG}}
Flagged code: {{SNIPPET}}
{{ENCLOSING_NAME_LINE}}

Enclosing function ({{FILE}}:{{LINE}}):
\`\`\`typescript
{{ENCLOSING}}
\`\`\`
`;

export class MutationConfirmer {
  private llm: MlxLlmClient;
  private cache = new Map<string, MutationVerdict>();

  constructor(llm?: MlxLlmClient) {
    this.llm = llm ?? new MlxLlmClient();
  }

  async confirm(input: MutationCheckInput): Promise<MutationVerdict | null> {
    const cacheKey = `${input.file}:${input.line}:${input.pattern}:${input.snippet}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // Skip the verdict when the enclosing source is too large for the local
    // 4096-token context. Truncating the body strips the surrounding code
    // that determines intentional-vs-bug, so a partial verdict is worse
    // than no verdict — let the deterministic Tier-1 finding stand.
    const ENCLOSING_BUDGET_CHARS = 2500;
    if (input.enclosingSource.length > ENCLOSING_BUDGET_CHARS) {
      logger.info(
        { file: input.file, line: input.line, size: input.enclosingSource.length },
        'MutationConfirmer: enclosing source too large for local context, skipping verdict',
      );
      return null;
    }

    const prompt = PROMPT.replace('{{PATTERN}}', input.pattern)
      .replace('{{ESCAPE_TAG}}', input.escapes ? ' (escapes via return / this / call)' : '')
      .replace('{{SNIPPET}}', input.snippet)
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
        'MutationConfirmer failed; returning null',
      );
      return null;
    }
  }
}
