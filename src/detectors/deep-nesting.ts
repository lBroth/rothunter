import * as crypto from 'node:crypto';
import type { Finding, SymbolRecord } from '../types.js';

export interface DeepNestingDetectorInput {
  symbols: ReadonlyArray<SymbolRecord>;
  /** Nesting depth that triggers LOW. Default 4. */
  lowThreshold?: number;
  /** Nesting depth that triggers MED. Default 5. */
  medThreshold?: number;
  /** Nesting depth that triggers HIGH. Default 6. */
  highThreshold?: number;
}

// Max if/for/while/try/switch depth per function via regex single-pass.
// LOW ≥4, MED ≥5, HIGH ≥6.
export function detectDeepNesting(input: DeepNestingDetectorInput): Finding[] {
  const low = input.lowThreshold ?? 4;
  const med = input.medThreshold ?? 5;
  const high = input.highThreshold ?? 6;
  const findings: Finding[] = [];
  for (const sym of input.symbols) {
    if (sym.kind !== 'function') continue;
    const depth = maxNestingDepth(sym.source);
    if (depth < low) continue;
    const severity: 'high' | 'medium' | 'low' = depth >= high ? 'high' : depth >= med ? 'medium' : 'low';
    findings.push({
      detectorId: 'deep-nesting',
      severity,
      confidence: 0.85,
      layer: 1,
      title: `Deeply nested function: \`${sym.name}\` (depth ${depth}) in ${sym.file}`,
      description:
        `\`${sym.name}\` reaches ${depth} levels of nested control flow. Past depth 4 the reader has to track too many active conditions at once.`,
      evidence: [
        {
          file: sym.file,
          range: { startLine: sym.range.startLine, endLine: sym.range.endLine },
          snippet: sym.source.split('\n').slice(0, 4).join('\n'),
        },
      ],
      suggestion:
        'Invert the deepest condition with an early return ("guard clause"). Replace nested if/else trees with a discriminated dispatch table. Extract inner loops into named helpers.',
      fingerprint: `deep-nesting:${stableHash(`${sym.file}:${sym.name}:${sym.range.startLine}`)}`,
    });
  }
  return findings;
}

/**
 * Counts the maximum depth of control-flow nesting in a function body.
 * Walks the source once, ignoring strings/comments, and tracks the
 * brace stack alongside the most recent keyword introducing each block.
 *
 * Only `if`/`for`/`while`/`switch`/`try`/`catch` keyword-introduced
 * braces count toward depth — plain object literals and function-bodies
 * don't inflate the metric.
 */
function maxNestingDepth(source: string): number {
  const masked = maskStringsAndComments(source);
  let depth = 0;
  let max = 0;
  const stack: Array<'control' | 'other'> = [];
  // Use a sliding 16-char lookbehind for the most recent keyword.
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === '{') {
      const before = masked.slice(Math.max(0, i - 20), i);
      const isControl = /\b(?:if|else|for|while|switch|try|catch|finally|do)\b\s*(?:\([^)]*\)\s*)?$/.test(before);
      stack.push(isControl ? 'control' : 'other');
      if (isControl) {
        depth++;
        if (depth > max) max = depth;
      }
    } else if (c === '}') {
      const popped = stack.pop();
      if (popped === 'control' && depth > 0) depth--;
    }
  }
  return max;
}

function maskStringsAndComments(raw: string): string {
  let out = '';
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    const next = raw[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += '\n';
      } else out += ' ';
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i++;
      } else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (inString) {
      if (c === '\\') {
        out += '  ';
        i++;
        continue;
      }
      if (c === inString) {
        inString = null;
        out += c;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

function stableHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
