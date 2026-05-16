// OpenAI-compat /v1/chat/completions client. Works with llama-server, vLLM,
// OpenRouter. Env: ROTHUNTER_LLM_BASE_URL / _MODEL / _API_KEY / _TIMEOUT_MS.
// mlx_lm.server avoided — wedges under sustained sequential load.

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

export interface MlxLlmClientOptions {
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
// Qwen2.5-Coder-14B Q4_K_M (~8GB) hits 8/8 on the golden eval — the smallest
// local model we have evaluated that gets every borderline pair right.
const DEFAULT_MODEL = 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF';
const DEFAULT_TIMEOUT_MS = 120_000;

export class MlxLlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly defaultTimeoutMs: number;

  /**
   * Pure constructor — never reads process.env. Pass explicit opts (typical
   * production wiring is via `createDefaultLlmClient()`, which collects env
   * defaults). Keeping the constructor env-free makes the class trivially
   * mockable + test-isolated: a test setting `process.env.ROTHUNTER_LLM_*`
   * cannot leak into an unrelated test that instantiates this directly.
   */
  constructor(opts: MlxLlmClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.apiKey = opts.apiKey;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0,
      // Hard cap by default. Without this the server happily generates thousands
      // of tokens and a single request can monopolize the worker for minutes.
      // 512 is enough for the LlmConfirmer verdict JSON even when the backend
      // is a reasoning-tuned model that emits a <think>...</think> block before
      // the structured answer.
      max_tokens: options.maxTokens ?? 512,
    };
    // NOTE: not setting `response_format: {type: 'json_object'}` deliberately.
    // mlx_lm.server has a known issue where grammar-constrained generation
    // (the way json_object is enforced) drives the process into a multi-minute
    // post-request loop, eventually wedging the server entirely after a handful
    // of calls. The caller still asks for JSON in the prompt and we parse it
    // best-effort downstream — that's reliable enough and keeps the server alive.

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
        throw new Error(`MLX-LM HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const err = typeof data.error === 'string' ? data.error : data.error?.message;
      if (err) throw new Error(`MLX-LM error: ${err}`);
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Issues a tiny completion to ensure the model is loaded into memory and the
   * first forward pass is compiled. Best-effort — errors are swallowed.
   */
  async warmup(): Promise<void> {
    try {
      await this.chat(
        [{ role: 'user', content: 'ok' }],
        { temperature: 0, maxTokens: 1, timeoutMs: this.defaultTimeoutMs },
      );
    } catch {
      // best-effort warmup; main chat() will surface real errors
    }
  }
}

/**
 * Build an MlxLlmClient from `ROTHUNTER_LLM_*` env vars (with the standard
 * fallback chain for the API key: ROTHUNTER_LLM_API_KEY → OPENROUTER_API_KEY
 * → OPENAI_API_KEY). All production call sites that previously did
 * `new MlxLlmClient()` now route through here so env coupling lives in one
 * place. Tests construct `MlxLlmClient` directly with explicit opts to
 * bypass env reads.
 */
export function createDefaultLlmClient(): MlxLlmClient {
  const envTimeout = Number(process.env.ROTHUNTER_LLM_TIMEOUT_MS);
  return new MlxLlmClient({
    baseUrl: process.env.ROTHUNTER_LLM_BASE_URL,
    model: process.env.ROTHUNTER_LLM_MODEL,
    apiKey:
      process.env.ROTHUNTER_LLM_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      process.env.OPENAI_API_KEY,
    defaultTimeoutMs:
      Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined,
  });
}
