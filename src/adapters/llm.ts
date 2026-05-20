// OpenAI-compat /v1/chat/completions client. Works with llama-server,
// vLLM, OpenRouter, LM Studio, and any other backend that speaks the
// OpenAI chat-completion schema.
//
// Env: ROTHUNTER_LLM_BASE_URL / _MODEL / _API_KEY / _TIMEOUT_MS.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  json?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface LlmClientOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  defaultTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { role: string; content: string } }>;
  error?: { message?: string } | string;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';
// Qwen2.5-Coder-14B Q4_K_M (~8GB) hits 8/8 on the golden eval — the
// smallest local model we evaluated that gets every borderline pair
// right.
const DEFAULT_MODEL = 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF';
const DEFAULT_TIMEOUT_MS = 120_000;

export class LlmClient {
  private readonly baseUrl: string;
  private readonly modelOverride: string | undefined;
  private readonly apiKey?: string;
  private readonly defaultTimeoutMs: number;
  /**
   * Resolved model id used in actual requests. Populated either from
   * the explicit override (env / constructor) or via a one-shot probe
   * of `GET /v1/models` against the configured base URL. The probe
   * keeps `npm run dev:full` working when the operator's env override
   * doesn't match what the backend actually has loaded.
   */
  private resolvedModel: string | undefined;
  /** Tag of the backend we resolved against — exposed for the settings UI. */
  public resolvedBackend: 'llamacpp' | 'remote' | 'unknown' = 'unknown';

  /**
   * Pure constructor — never reads process.env. Pass explicit opts
   * (typical production wiring is via `createDefaultLlmClient()`, which
   * collects env defaults). Keeping the constructor env-free makes the
   * class trivially mockable + test-isolated.
   */
  constructor(opts: LlmClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.modelOverride = opts.model;
    this.resolvedModel = opts.model;
    this.apiKey = opts.apiKey;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One-shot model discovery against `/v1/models`. Picks a sensible
   * default when the operator hasn't set `ROTHUNTER_LLM_MODEL` or when
   * the operator's override is no longer loaded on the backend.
   * Idempotent — repeat calls reuse `resolvedModel`.
   */
  private async resolveModel(): Promise<string | undefined> {
    if (this.resolvedModel && this.resolvedBackend !== 'unknown') return this.resolvedModel;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
      });
      if (!res.ok) return this.resolvedModel;
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) return this.resolvedModel;
      const looksLocal = /127\.0\.0\.1|localhost|0\.0\.0\.0|host\.docker\.internal/.test(this.baseUrl);
      this.resolvedBackend = looksLocal ? 'llamacpp' : 'remote';

      // Honour the operator override when set + still reachable;
      // otherwise fall back to the first reported id.
      if (this.modelOverride && ids.includes(this.modelOverride)) {
        this.resolvedModel = this.modelOverride;
      } else {
        this.resolvedModel = ids[0]!;
      }
      return this.resolvedModel;
    } catch {
      return this.resolvedModel;
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const model = (await this.resolveModel()) ?? this.modelOverride ?? DEFAULT_MODEL;

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0,
      // Hard cap by default. Without this the server happily generates
      // thousands of tokens and a single request can monopolize the
      // worker for minutes. 512 is enough for verdict JSON even when
      // the backend is a reasoning-tuned model emitting a <think>
      // block before the structured answer.
      max_tokens: options.maxTokens ?? 512,
    };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const err = typeof data.error === 'string' ? data.error : data.error?.message;
      if (err) throw new Error(`LLM error: ${err}`);
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Issues a tiny completion to ensure the model is loaded into memory
   * and the first forward pass is compiled. Uses a short timeout
   * (5 s) so the orchestrator can detect "no LLM available" quickly
   * and skip the confirmation pass instead of spending the full
   * verdict timeout on every finding.
   *
   * Returns `true` on success, `false` on any failure — let the caller
   * decide whether to continue, retry, or fall back to deterministic
   * verdicts only.
   */
  async warmup(): Promise<boolean> {
    try {
      await this.chat(
        [{ role: 'user', content: 'ok' }],
        { temperature: 0, maxTokens: 1, timeoutMs: 5_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Read the marker file written by `scripts/start-llm.mjs` so the server
 * picks up the model + port that script actually launched, without
 * needing the operator to keep ROTHUNTER_LLM_MODEL in sync by hand.
 * Returns null when no marker exists.
 */
function readLlmMarker(): { backend?: string; model?: string; port?: string } | null {
  try {
    const p = path.join(os.homedir(), '.rothunter', 'llm-active.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as { backend?: string; model?: string; port?: string };
  } catch {
    return null;
  }
}

/**
 * Build an LlmClient from `ROTHUNTER_LLM_*` env vars (with the standard
 * fallback chain for the API key: ROTHUNTER_LLM_API_KEY →
 * OPENROUTER_API_KEY → OPENAI_API_KEY). All production call sites route
 * through here so env coupling lives in one place. Tests construct
 * `LlmClient` directly with explicit opts to bypass env reads.
 */
export function createDefaultLlmClient(): LlmClient {
  const envTimeout = Number(process.env.ROTHUNTER_LLM_TIMEOUT_MS);
  // Marker beats the hard-coded default but loses to an explicit env
  // override. Operator wins, automation second, default last.
  const marker = readLlmMarker();
  const baseUrl =
    process.env.ROTHUNTER_LLM_BASE_URL ??
    (marker?.port ? `http://127.0.0.1:${marker.port}/v1` : undefined);
  const model = process.env.ROTHUNTER_LLM_MODEL ?? marker?.model;
  return new LlmClient({
    baseUrl,
    model,
    apiKey:
      process.env.ROTHUNTER_LLM_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      process.env.OPENAI_API_KEY,
    defaultTimeoutMs:
      Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined,
  });
}
