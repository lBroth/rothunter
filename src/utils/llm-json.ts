export function parseLlmJsonResponse(raw: string): unknown {
  const cleaned = stripCodeFence(raw).trim();
  if (!cleaned) throw new Error('Empty LLM response');

  try {
    return JSON.parse(cleaned);
  } catch {
    const extracted = extractFirstJsonObject(cleaned);
    if (extracted) return JSON.parse(extracted);
    throw new Error(`LLM response is not valid JSON: ${cleaned.slice(0, 200)}`);
  }
}

function stripCodeFence(s: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const m = s.trim().match(fence);
  return m ? m[1] : s;
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
