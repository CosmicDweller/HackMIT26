import { GoogleGenAI } from "@google/genai";

// Google Gemini, used ONLY to draft documentation from a transcript the backend already has. Nothing else in the app talks to it.
//
// Privacy: the request carries transcript text and the doctor's typed context, nothing else. Never audio, never voice embeddings,
// never tokens, never a doctor's identity. Prompt and response CONTENT is never logged (only codes, token counts and timings), so a
// consultation cannot leak into a log file.
// Money: free-tier models only, bounded retries, one request at a time by default. The key lives in the server environment and never
// reaches the browser.

export class SoapProviderError extends Error {
  constructor(code, { status = null, retryable = false, detail = "" } = {}) {
    super(code);
    this.name = "SoapProviderError";
    this.code = code; // PROVIDER_NOT_CONFIGURED | PROVIDER_AUTH_FAILED | PROVIDER_RATE_LIMITED | PROVIDER_QUOTA_EXCEEDED |
    this.status = status; // PROVIDER_TIMEOUT | PROVIDER_UNAVAILABLE | PROVIDER_MODEL_UNAVAILABLE | PROVIDER_BAD_OUTPUT | PROVIDER_FAILED
    this.retryable = retryable;
    this.detail = detail; // a short class of failure, never prompt or clinical content
  }
}

/** Classify a provider failure from its status and message. The message is never stored or logged verbatim. */
export function classify(error) {
  const status = error?.status ?? error?.code ?? error?.response?.status ?? null;
  const text = String(error?.message ?? "").toLowerCase();
  if (error?.name === "AbortError" || text.includes("timeout") || text.includes("timed out") || text.includes("deadline")) {
    return new SoapProviderError("PROVIDER_TIMEOUT", { status, retryable: true });
  }
  if (status === 401 || status === 403 || text.includes("api key") || text.includes("permission denied") || text.includes("unauthenticated")) {
    return new SoapProviderError("PROVIDER_AUTH_FAILED", { status, retryable: false });
  }
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) {
    // Free tier: a per-minute rate limit is worth retrying; an exhausted daily quota is not.
    const daily = text.includes("quota") && (text.includes("per day") || text.includes("daily") || text.includes("exceeded your current quota"));
    return daily
      ? new SoapProviderError("PROVIDER_QUOTA_EXCEEDED", { status, retryable: false })
      : new SoapProviderError("PROVIDER_RATE_LIMITED", { status, retryable: true });
  }
  if (status === 404 || text.includes("not found") || text.includes("is not supported") || text.includes("does not exist")) {
    return new SoapProviderError("PROVIDER_MODEL_UNAVAILABLE", { status, retryable: false });
  }
  if (status === 400 || text.includes("invalid argument")) return new SoapProviderError("PROVIDER_FAILED", { status, retryable: false, detail: "rejected request" });
  if ((typeof status === "number" && status >= 500) || text.includes("unavailable") || text.includes("overloaded") || text.includes("internal")) {
    return new SoapProviderError("PROVIDER_UNAVAILABLE", { status, retryable: true });
  }
  if (text.includes("fetch failed") || text.includes("network") || text.includes("econnreset") || text.includes("enotfound")) {
    return new SoapProviderError("PROVIDER_UNAVAILABLE", { status, retryable: true });
  }
  return new SoapProviderError("PROVIDER_FAILED", { status, retryable: false });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
});

/**
 * The Gemini client used for SOAP drafting.
 *   generate({ system, user, schema, stage }) -> { data, usage }
 * `data` is the parsed structured output (validated against `schema` by the provider, re-validated by the caller: valid JSON is not
 * the same as trustworthy content). `usage` carries token counts for cost tracking.
 */
export function createSoapProvider(config, { logger = console, client = null } = {}) {
  const apiKey = config.geminiApiKey ?? "";
  const ai = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);
  let running = 0;
  const waiting = [];
  const acquire = () => (running < config.soapMaxConcurrent ? (running++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

  const configured = () => Boolean(ai);

  async function generate({ system, user, schema, stage = "generate", signal }) {
    if (!ai) throw new SoapProviderError("PROVIDER_NOT_CONFIGURED", { detail: "GEMINI_API_KEY is not set" });
    await acquire();
    try {
      let lastError = null;
      for (let attempt = 0; attempt <= config.soapMaxRetries; attempt++) {
        if (signal?.aborted) throw new SoapProviderError("PROVIDER_FAILED", { detail: "cancelled" });
        const started = Date.now();
        const timer = new AbortController();
        const timeout = setTimeout(() => timer.abort(), config.soapTimeoutMs);
        try {
          const response = await ai.models.generateContent({
            model: config.soapModel,
            contents: [{ role: "user", parts: [{ text: user }] }],
            config: {
              systemInstruction: system,
              responseMimeType: "application/json",
              responseSchema: schema,
              temperature: config.soapTemperature, // low: this is documentation, not prose
              maxOutputTokens: config.soapMaxOutputTokens,
              abortSignal: timer.signal,
            },
          });
          const text = response?.text;
          if (!text) {
            // A blocked or truncated answer: no content to parse. MAX_TOKENS is worth reporting precisely.
            const reason = response?.candidates?.[0]?.finishReason ?? "no text";
            throw new SoapProviderError("PROVIDER_BAD_OUTPUT", { detail: String(reason).slice(0, 40), retryable: String(reason) !== "MAX_TOKENS" });
          }
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new SoapProviderError("PROVIDER_BAD_OUTPUT", { detail: "not JSON", retryable: true });
          }
          const meta = response?.usageMetadata ?? {};
          const usage = {
            inputTokens: meta.promptTokenCount ?? null,
            outputTokens: meta.candidatesTokenCount ?? null,
            totalTokens: meta.totalTokenCount ?? null,
            ms: Date.now() - started,
          };
          // counts and timing only: never the prompt, the transcript or the note
          logger.log(`soap ${stage}: ${config.soapModel} ok in ${usage.ms} ms (${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out tokens)`);
          return { data, usage };
        } catch (error) {
          const classified = error instanceof SoapProviderError ? error : classify(error);
          lastError = classified;
          const canRetry = classified.retryable && attempt < config.soapMaxRetries;
          logger.error(`soap ${stage}: ${classified.code}${classified.detail ? ` (${classified.detail})` : ""}${canRetry ? ", retrying" : ""}`);
          if (!canRetry) throw classified;
          await sleep(config.soapRetryBaseMs * 2 ** attempt, signal);
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError ?? new SoapProviderError("PROVIDER_FAILED");
    } finally {
      release();
    }
  }

  return { configured, generate, model: config.soapModel, provider: "gemini" };
}
