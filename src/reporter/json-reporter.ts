import type { Finding } from '../types.js';

export interface JsonReportInput {
  workspaceRoot: string;
  generatedAt: Date;
  durationMs: number;
  symbolCount: number;
  findings: Finding[];
  /** Min-confidence threshold used by this run. */
  minConfidence: number;
}

export function renderJsonReport(input: JsonReportInput): string {
  const visible = input.findings.filter((f) => f.confidence >= input.minConfidence);
  const hidden = input.findings.filter((f) => f.confidence < input.minConfidence);

  const counts = {
    total: input.findings.length,
    shown: visible.length,
    hidden: hidden.length,
    bySeverity: countBy(visible, (f) => f.severity),
  };

  return (
    JSON.stringify(
      {
        workspace: input.workspaceRoot,
        generated_at: input.generatedAt.toISOString(),
        duration_ms: input.durationMs,
        symbols_scanned: input.symbolCount,
        min_confidence: input.minConfidence,
        counts,
        findings: visible,
      },
      null,
      2,
    ) + '\n'
  );
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
