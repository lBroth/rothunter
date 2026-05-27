import { z } from 'zod';
import { LlmClient, createDefaultLlmClient } from '../adapters/llm.js';
import { parseLlmJsonResponse } from '../utils/llm-json.js';
import { logger } from '../utils/logger.js';

/**
 * Generic single-finding triage confirmer. Used by detectors whose
 * findings have a high false-positive rate but no detector-specific
 * confirmer of their own (silent-catch, public-any, mutable-globals,
 * …). Asks the LLM: "given this code and the static analyzer's
 * suspicion, is this a real defect worth fixing — or an intentional
 * pattern the project relies on?"
 *
 * Verdict shape matches the cluster confirmers so the orchestrator's
 * shared `applyClusterVerdict` helper can drive severity / confidence
 * adjustments without a per-detector branch:
 *
 *   { real: boolean, confidence: number 0..1, reason: string }
 *
 * `real: true`  → keep severity, bump confidence (genuine defect).
 * `real: false` → drop severity to 'low', deflate confidence
 *                 (intentional pattern / framework convention).
 */
const VerdictSchema = z.object({
  real: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type TriageVerdict = z.infer<typeof VerdictSchema>;

export interface TriageCheckInput {
  /** Detector id — included in the prompt so the LLM applies the right rubric. */
  detectorId: string;
  /** Human-facing severity ('low' | 'medium' | 'high') from the deterministic pass. */
  severity: string;
  /** Finding title verbatim. */
  title: string;
  /** Finding description verbatim. */
  description: string;
  /** Detector-emitted suggestion, if any. */
  suggestion?: string;
  /** First evidence file + line range + snippet. */
  evidenceFile: string;
  evidenceStartLine: number;
  evidenceEndLine: number;
  evidenceSnippet: string;
  /**
   * Optional structural context the orchestrator can pass alongside the
   * raw evidence — siblings, importer counts, package.json hits, etc.
   * Kept opaque (free-form text) so detector-specific enrichment can
   * evolve without breaking the schema. Truncated server-side to keep
   * the prompt under the LLM context window.
   */
  extraContext?: string;
}

const PROMPT = `You are reviewing a TypeScript / JavaScript static-analysis finding. Decide: is this a REAL defect the project should fix, or a FALSE POSITIVE the detector flagged but the code is intentionally written this way (framework convention, builder pattern, project-specific exception)?

Output ONE compact JSON object and STOP:
{"real": boolean, "confidence": <0..1>, "reason": "<max 20 words>"}

Heuristics by detector:

- **silent-catch**: REAL when the catch swallows errors that the operator would want to see (network, parse, DB). FALSE when the catch is documented as deliberate (comment explaining), the surrounding code already logs to a reporter, or the body is "return null" with a documented caller contract that treats null as "missing".
- **public-any**: REAL when an exported API surface uses \`any\` where a concrete type or a generic would convey the contract. FALSE when the \`any\` is at a third-party adapter boundary, in a generated type, or annotated with a comment explaining the deliberate widening.
- **mutable-globals**: REAL when a module-scope \`let\`/\`var\` is mutated from request-time code (shared across importers). FALSE when the mutation is bootstrap / one-shot init / lazy-cache with single-flight guards.
- **magic-numbers**: REAL when the literal carries domain meaning the reader has to guess (timeouts, retry counts, column counts). FALSE for: math constants (0/1/2/-1/π/τ), array indices, version numbers in package.json reads, HTTP status codes (200/404/500) used with descriptive variable names already in scope.
- **bad-config**: REAL when the disabled rule materially loosens safety (strict / noImplicitAny / no-explicit-any). FALSE when the rule is off behind a documented project-wide exception OR when the file is a build target intentionally relaxed (e.g. tsconfig.build.json with project references).
- **long-function**: REAL when the function mixes unrelated concerns. FALSE for React page components that act as composition roots and JSX layout — a 300+ line page is typical and refactor signals are already covered by other detectors. FALSE for linear HTTP handlers / streaming relays where extraction obscures flow.
- **long-file**: REAL when the file accumulates unrelated concerns across many features. FALSE for recognizer / config / pattern tables — single-table modules of 600+ lines are deliberate locality, not accumulation.
- **hot-hub-file**: REAL when a file accumulates unrelated re-exports / utilities. FALSE for a deliberate single type-surface module / barrel that the project explicitly maintains as the public import path.
- **dead-export**: REAL when the export is unused AND has no plausible public-API reason to exist. FALSE when: (a) the symbol IS the published-library type surface for an Apache/MIT npm package, (b) the export is consumed by another exported symbol's signature within the same module (interface used as return / param type), (c) it's a framework convention (Next route handler, etc.).
- **dead-module**: REAL when the file is genuinely unreachable. FALSE when: package.json scripts reference it (\`tsx watch src/dev.ts\`), it's loaded by convention (Next route, Vite plugin), or it's a dev-only entry point.
- **dead-handler / dead-api**: REAL when no client / route table references it. FALSE when the handler is registered dynamically (decorator + reflection, route table built at runtime).
- **todo-comments**: REAL only for actionable TODO / FIXME / HACK / XXX markers ("TODO: refactor", "FIXME before ship"). FALSE for explanatory NOTE comments documenting a deliberate design decision — those are documentation, not technical debt.
- **duplicate-function / duplicate-type / similar-functions**: REAL when two symbols implement the same concept with different code (true duplication). FALSE when they share a SKELETON but have unrelated semantics — \`registerDoctor\` vs \`registerPrefetch\`, \`getUserById\` vs \`getOrderById\`, framework-idiom command registrations.

Confidence calibration:
- Clear intentional pattern with explicit comment / framework idiom → real: false, confidence ≥ 0.85.
- Clear defect (no comment, obvious bug shape) → real: true, confidence ≥ 0.85.
- Genuinely ambiguous → real: true, confidence 0.6 (preserve the deterministic signal at low confidence).

If the "Project conventions" block in extra context contains a rule that DIRECTLY justifies the pattern under review (e.g. "three similar lines better than premature abstraction" → applies to duplicate-function / long-function on framework-idiom call sites; "default to writing no comments" → applies to silent-catch with explanatory comment), treat that as authoritative and verdict real: false, confidence ≥ 0.85. The project's own rules override generic best-practice — that is the whole point of including them.

Detector: {{DETECTOR}}
Severity (deterministic): {{SEVERITY}}
Title: {{TITLE}}
Description: {{DESCRIPTION}}
Suggested direction: {{SUGGESTION}}

Code evidence ({{FILE}}:{{START}}-{{END}}):
\`\`\`
{{SNIPPET}}
\`\`\`
{{EXTRA_CONTEXT}}`;

export class TriageConfirmer {
  private llm: LlmClient;
  private cache = new Map<string, TriageVerdict>();

  constructor(llm?: LlmClient) {
    this.llm = llm ?? createDefaultLlmClient();
  }

  async confirm(input: TriageCheckInput): Promise<TriageVerdict | null> {
    const cacheKey = `${input.detectorId}::${input.evidenceFile}:${input.evidenceStartLine}-${input.evidenceEndLine}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const extraBlock = input.extraContext
      ? `\nExtra structural context:\n${input.extraContext.slice(0, 1600)}\n`
      : '';
    const prompt = PROMPT.replace('{{DETECTOR}}', input.detectorId)
      .replace('{{SEVERITY}}', input.severity)
      .replace('{{TITLE}}', input.title)
      .replace('{{DESCRIPTION}}', input.description.slice(0, 800))
      .replace('{{SUGGESTION}}', input.suggestion ?? '(none)')
      .replace('{{FILE}}', input.evidenceFile)
      .replace('{{START}}', String(input.evidenceStartLine))
      .replace('{{END}}', String(input.evidenceEndLine))
      .replace('{{SNIPPET}}', input.evidenceSnippet.slice(0, 1600))
      .replace('{{EXTRA_CONTEXT}}', extraBlock);

    try {
      const raw = await this.llm.chat([{ role: 'user', content: prompt }], {
        temperature: 0,
        maxTokens: 128,
      });
      const parsed = parseLlmJsonResponse(raw);
      const verdict = VerdictSchema.parse(parsed);
      this.cache.set(cacheKey, verdict);
      return verdict;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, detector: input.detectorId, file: input.evidenceFile },
        'TriageConfirmer failed; returning null',
      );
      return null;
    }
  }
}
