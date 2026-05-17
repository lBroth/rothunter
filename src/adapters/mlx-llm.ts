/**
 * Local LLM client — talks to any OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Recommended backend on Apple Silicon: llama.cpp's `llama-server` (stable under
 * sustained sequential load). Default model is Qwen2.5-Coder-14B Q4_K_M which
 * scored 8/8 on the golden eval set; smaller variants (7B Q4, DeepSeek-V2-Lite
 * MoE) all scored 7/8 on the same set.
 *
 *   brew install llama.cpp
 *   llama-server -hf bartowski/Qwen2.5-Coder-14B-Instruct-GGUF:Q4_K_M \
 *                --port 8080 --jinja -c 4096 -n 256 --host 127.0.0.1
 *
 * mlx_lm.server has been tested and avoided: it logs HTTP 200 but fails to
 * flush response bodies to the socket under sustained sequential load, wedging
 * after a handful of requests.
 *
 * Env vars (with defaults):
 *   ROTHUNTER_LLM_BASE_URL   http://127.0.0.1:8080/v1
 *   ROTHUNTER_LLM_MODEL      bartowski/Qwen2.5-Coder-14B-Instruct-GGUF
 *   ROTHUNTER_LLM_API_KEY    (optional)
 *   ROTHUNTER_LLM_TIMEOUT_MS 300000
 *
 * The class name is historical; the protocol is plain OpenAI-compat and works
 * with llama-server, mlx_lm.server, vLLM, OpenRouter, etc.
 */

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

  constructor(opts: MlxLlmClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.ROTHUNTER_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.model = opts.model ?? process.env.ROTHUNTER_LLM_MODEL ?? DEFAULT_MODEL;
    this.apiKey =
      opts.apiKey ??
      process.env.ROTHUNTER_LLM_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      process.env.OPENAI_API_KEY ??
      undefined;

    const envTimeout = Number(process.env.ROTHUNTER_LLM_TIMEOUT_MS);
    this.defaultTimeoutMs =
      opts.defaultTimeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
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
