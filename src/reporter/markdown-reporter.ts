import type { Finding } from '../types.js';

interface ReportOptions {
  workspaceRoot: string;
  minConfidence: number;
  generatedAt: Date;
  durationMs: number;
  symbolCount: number;
}

const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 } as const;

export function renderMarkdownReport(findings: Finding[], opts: ReportOptions): string {
  const visible = findings.filter((f) => f.confidence >= opts.minConfidence);
  const hidden = findings.length - visible.length;
  visible.sort((a, b) => {
    const sev = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (sev !== 0) return sev;
    return b.confidence - a.confidence;
  });

  const lines: string[] = [];
  lines.push('# RotHunter audit');
  lines.push('');
  lines.push(`- Workspace: \`${opts.workspaceRoot}\``);
  lines.push(`- Generated: ${opts.generatedAt.toISOString()}`);
  lines.push(`- Symbols scanned: ${opts.symbolCount}`);
  lines.push(`- Duration: ${(opts.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Findings: ${visible.length} (shown) / ${findings.length} (total)`);
  lines.push(`- Min confidence: ${opts.minConfidence}`);
  if (hidden > 0) {
    lines.push(`- Hidden by confidence threshold: ${hidden}`);
  }
  lines.push('');

  if (visible.length === 0) {
    lines.push('_No findings above the confidence threshold._');
    return lines.join('\n');
  }

  const byDetector = new Map<string, Finding[]>();
  for (const f of visible) {
    const list = byDetector.get(f.detectorId) ?? [];
    list.push(f);
    byDetector.set(f.detectorId, list);
  }

  for (const [detectorId, list] of byDetector) {
    lines.push(`## ${detectorId} (${list.length})`);
    lines.push('');
    for (const f of list) {
      lines.push(`### ${severityIcon(f.severity)} ${f.title}`);
      lines.push('');
      lines.push(
        `> confidence ${f.confidence.toFixed(2)} · layer ${f.layer} · fingerprint \`${f.fingerprint}\``,
      );
      lines.push('');
      lines.push(f.description);
      lines.push('');
      if (f.evidence.length > 0) {
        lines.push('**Evidence:**');
        lines.push('');
        for (const ev of f.evidence) {
          lines.push(`- \`${ev.file}:${ev.range.startLine}\``);
          lines.push('  ```typescript');
          for (const line of ev.snippet.split('\n')) {
            lines.push(`  ${line}`);
          }
          lines.push('  ```');
        }
        lines.push('');
      }
      if (f.suggestion) {
        lines.push(`**Suggestion:** ${f.suggestion}`);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
  }
  return lines.join('\n');
}

function severityIcon(s: Finding['severity']): string {
  switch (s) {
    case 'high':
      return '[high]';
    case 'medium':
      return '[med]';
    case 'low':
      return '[low]';
  }
}
