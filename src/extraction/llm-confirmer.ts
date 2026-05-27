import { z } from 'zod';
import { LlmClient, createDefaultLlmClient } from '../adapters/llm.js';
import { parseLlmJsonResponse } from '../utils/llm-json.js';
import { logger } from '../utils/logger.js';
import type { SymbolRecord } from '../types.js';

const ConfirmationSchema = z.object({
  same_concept: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type ConfirmationResult = z.infer<typeof ConfirmationSchema>;

// Anchored on fields, not names. Smaller LLMs default to "different concept"
// when names differ, even with identical fields — counter that here.
const PROMPT = `You are deciding whether two TypeScript types are duplicates that should be unified.

CRITICAL: A static analyzer ALREADY proved their structures match. Field names will often differ — that is the WHOLE POINT of running this check. Different names with matching structures usually mean a duplicate that drifted under different aliases, NOT two different concepts. Default to "same_concept: true" unless the shape is so small (≤2 generic primitives) that the match is coincidental AND the field names also differ.

If field NAMES match exactly AND the type names also relate to the same concept, this is same_concept: true.
If field NAMES match exactly BUT the type names point to clearly unrelated subsystems (e.g. \`Template\` from a cloud-provider DTO vs \`Document\` from a test fixture), the field overlap is coincidental — same_concept: false.
If field TYPES match but names differ AND the shape has ≥4 fields with mixed types, this is same_concept: true.
Tiny generic shapes ({id, name}, {x, y}, {key, value}, {host, port}) across unrelated type names are ALWAYS coincidental → same_concept: false. The type names are the only evidence here — use them.

Output exactly ONE JSON object, then STOP:
{"same_concept": <boolean>, "confidence": <0..1>, "reason": "<max 12 words>"}

Worked examples (study these — they show the expected behavior):

Example 1 (rename + retype-equivalent):
A: interface ShipmentEntry { trackingId: string; weightKg: number; delivered: boolean; shippedOn: string; }
B: interface ParcelRow { code: string; mass: number; arrived: boolean; dispatchDate: string; }
→ {"same_concept": true, "confidence": 0.9, "reason": "1:1 field map under rename — same shipment row"}

Example 2 (identical fields, different type names):
A: interface InboundEvent { kind: string; payload: string; }
B: interface OutboundFrame { kind: string; payload: string; }
→ {"same_concept": true, "confidence": 0.95, "reason": "Identical fields, both model a message frame"}

Example 3 (snake ↔ camel + common synonyms):
A: interface CustomerSnake { cust_id: string; phone_number: string; signup_date: string; }
B: interface CustomerCamel { customerId: string; phone: string; createdAt: string; }
→ {"same_concept": true, "confidence": 0.9, "reason": "Snake↔camel + synonyms (phone, createdAt) — same customer"}

Example 4 (REJECT — too generic):
A: interface MenuItem { id: string; name: string; }
B: interface ApiToken { id: string; name: string; }
→ {"same_concept": false, "confidence": 0.85, "reason": "Tiny {id,name} shape across unrelated domains"}

Example 5 (REJECT — same shape, different semantics):
A: interface Vector { x: number; y: number; z: number; }
B: interface RGB { r: number; g: number; b: number; }
→ {"same_concept": false, "confidence": 0.9, "reason": "Same {number×3} but vector vs color semantics"}

Now decide for the real pair:
{{PROJECT_CONVENTIONS}}
Type A ({{FILE_A}}):
\`\`\`typescript
{{SOURCE_A}}
\`\`\`

Type B ({{FILE_B}}):
\`\`\`typescript
{{SOURCE_B}}
\`\`\`
`;

export class LlmConfirmer {
  private llm: LlmClient;
  private cache = new Map<string, ConfirmationResult>();

  constructor(llm?: LlmClient) {
    this.llm = llm ?? createDefaultLlmClient();
  }

  async confirmSameConcept(
    a: SymbolRecord,
    b: SymbolRecord,
    /**
     * Project conventions text (CLAUDE.md / AGENTS.md / etc., already
     * concatenated and truncated). When present, the verdict weighs
     * project-stated rules — e.g. "three similar lines is better than
     * premature abstraction" turns this into `same_concept: false` even
     * on a tight skeleton match.
     */
    projectConventions?: string,
  ): Promise<ConfirmationResult | null> {
    const cacheKey = pairKey(a, b);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // Local llama.cpp default context is 4096 tokens. Two SymbolRecord
    // sources from heavy React components (Outline's Icon / SharePopover)
    // routinely overflow. If we can't fit both sources + the prompt
    // overhead in the budget, skip the LLM verdict and let the deterministic
    // finding stand at its Tier-1 confidence. Truncating type bodies loses
    // the field signal the verdict needs, so we prefer "no verdict" over
    // "verdict on a truncated body".
    const SOURCE_BUDGET_CHARS = 2500;
    if (a.source.length + b.source.length > SOURCE_BUDGET_CHARS) {
      logger.info(
        { a: a.name, b: b.name, sizeA: a.source.length, sizeB: b.source.length },
        'LLM confirmer: pair too large for local context, skipping verdict',
      );
      return null;
    }

    const conventionsBlock = projectConventions
      ? `\nProject conventions (treat as authoritative — override generic best-practice when in conflict):\n${projectConventions}\n`
      : '';
    const prompt = PROMPT.replace('{{FILE_A}}', a.file)
      .replace('{{SOURCE_A}}', a.source)
      .replace('{{FILE_B}}', b.file)
      .replace('{{SOURCE_B}}', b.source)
      .replace('{{PROJECT_CONVENTIONS}}', conventionsBlock);

    try {
      const raw = await this.llm.chat([{ role: 'user', content: prompt }], {
        temperature: 0,
        json: true,
      });
      const parsed = parseLlmJsonResponse(raw);
      const result = ConfirmationSchema.parse(parsed);
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, a: a.name, b: b.name },
        'LLM confirmer failed; returning null',
      );
      return null;
    }
  }
}

function pairKey(a: SymbolRecord, b: SymbolRecord): string {
  return [a.hashStrict ?? a.id, b.hashStrict ?? b.id].sort().join('|');
}
