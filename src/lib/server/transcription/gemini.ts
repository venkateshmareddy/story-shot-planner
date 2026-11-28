import { z } from "zod";
import type { AudioExtension } from "@/lib/audio";
import { cleanTranscript } from "@/lib/transcript-cleanup";
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL } from "@/lib/transcription";
import { toUsageRecord, type UsageRecord } from "@/lib/usage";
import {
  TranscriptionError,
  type TranscriptionErrorDetail,
  type TranscriptionFailure,
  type TranscriptionInput,
  type TranscriptionProvider,
  transcriptionPrompt,
} from "./provider";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_TRANSCRIBE_TIMEOUT_MS = 60_000;
export const GEMINI_TRANSCRIBE_MAX_OUTPUT_TOKENS = 8_192;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/;

/** M4A and WebM only arrive when the browser couldn't convert them to WAV. */
export const GEMINI_AUDIO_TYPES: Readonly<Record<AudioExtension, string>> = {
  mp3: "audio/mp3",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
};

export type GeminiConfig = { apiKey: string; model: string; timeoutMs?: number };

/** Null when GEMINI_API_KEY is missing or GEMINI_TRANSCRIBE_MODEL isn't a model id. */
export function geminiConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): GeminiConfig | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.GEMINI_TRANSCRIBE_MODEL?.trim() || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
  if (!MODEL_ID.test(model)) {
    console.warn("Transcription not configured", { step: "transcribe", provider: "gemini", reason: "invalid_model_id" });
    return null;
  }
  return { apiKey, model };
}

export function geminiTranscribeUrl(model: string): string {
  return `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
}

/** The one shape every Gemini model accepts: no system instruction, JSON mode or thinking config. */
export function geminiTranscribeBody({ audio, format, hint }: Omit<TranscriptionInput, "signal">) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text: transcriptionPrompt(hint) },
          {
            inline_data: {
              mime_type: GEMINI_AUDIO_TYPES[format],
              data: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: GEMINI_TRANSCRIBE_MAX_OUTPUT_TOKENS },
  };
}

const tokenCount = z.number().optional();

const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: tokenCount,
      candidatesTokenCount: tokenCount,
      thoughtsTokenCount: tokenCount,
      cachedContentTokenCount: tokenCount,
      totalTokenCount: tokenCount,
    })
    .optional(),
  modelVersion: z.string().optional(),
});

type GeminiResponse = z.infer<typeof geminiResponseSchema>;

const geminiErrorSchema = z.object({
  error: z.object({
    status: z.string().optional(),
    message: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

const FEATURE_NOT_ENABLED = /is not enabled for this model/i;
const HIGH_DEMAND = /high demand|overloaded/i;
const CODE_FENCE = /^```(?:(?:text|txt|plaintext|plain|markdown|md)?[ \t]*\n)?([\s\S]*?)\n?[ \t]*```$/i;
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["“", "”"],
  ["'", "'"],
  ["‘", "’"],
];

/** Thinking tokens are billed as output, so they count as output here. */
export function geminiUsage(response: Pick<GeminiResponse, "usageMetadata" | "modelVersion">, model: string): UsageRecord {
  const usage = response.usageMetadata ?? {};
  const returned = response.modelVersion?.trim().slice(0, 80);
  return toUsageRecord("transcribe", returned || model, {
    input_tokens: usage.promptTokenCount,
    output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    total_tokens: usage.totalTokenCount,
    input_tokens_details: { cached_tokens: usage.cachedContentTokenCount },
  });
}

/** Reads the provider message only to classify it; it is never logged or returned. */
async function httpFailure(response: Response): Promise<TranscriptionError> {
  let code: string | undefined;
  let reason: string | undefined;
  let message = "";
  try {
    const parsed = geminiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.status;
      reason = parsed.data.error.details?.find((detail) => detail.reason)?.reason;
      message = parsed.data.error.message ?? "";
    }
  } catch {}
  const detail: TranscriptionErrorDetail = { status: response.status, ...(code ? { code } : {}), ...(reason ? { reason } : {}) };
  const { status } = response;
  const failure: TranscriptionFailure =
    reason === "API_KEY_INVALID" || status === 401 || status === 403
      ? "auth"
      : status === 404
        ? "model"
        : status === 429
          ? "rate_limited"
          : status === 503 || code === "UNAVAILABLE" || HIGH_DEMAND.test(message)
            ? "busy"
            : status === 400 && code === "FAILED_PRECONDITION"
              ? "unavailable"
              : status === 400 && FEATURE_NOT_ENABLED.test(message)
                ? "unsupported_model"
                : status === 400
                  ? "bad_audio"
                  : "upstream";
  return new TranscriptionError(failure, detail);
}

function transportFailure(error: unknown, signal: AbortSignal, timeout: AbortSignal): TranscriptionError {
  if (signal.aborted) return new TranscriptionError("stopped");
  if (timeout.aborted) return new TranscriptionError("timeout");
  return new TranscriptionError("upstream", { error: error instanceof Error ? error.name : typeof error });
}

/** General models sometimes wrap the reply in one pair of quotes or a code fence. */
export function unwrapTranscript(output: string): string {
  const text = output.trim();
  const fenced = CODE_FENCE.exec(text);
  if (fenced && !fenced[1].includes("```")) return fenced[1].trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length < open.length + close.length || !text.startsWith(open) || !text.endsWith(close)) continue;
    const inner = text.slice(open.length, text.length - close.length);
    if (!inner.includes(open) && !inner.includes(close)) return inner.trim();
  }
  return text;
}

function transcriptFrom(response: GeminiResponse): string {
  if (response.promptFeedback?.blockReason) {
    throw new TranscriptionError("blocked", { reason: response.promptFeedback.blockReason });
  }
  const candidate = response.candidates?.[0];
  if (!candidate) throw new TranscriptionError("invalid_response", { reason: "no_candidate" });
  const finish = candidate.finishReason;
  if (finish === "MAX_TOKENS") throw new TranscriptionError("too_long", { reason: finish });
  if (finish && finish !== "STOP") throw new TranscriptionError("blocked", { reason: finish });
  const output = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
  return unwrapTranscript(output);
}

export function createGeminiTranscriber({ apiKey, model, timeoutMs = GEMINI_TRANSCRIBE_TIMEOUT_MS }: GeminiConfig): TranscriptionProvider {
  return {
    provider: "gemini",
    model,
    async transcribe({ signal, ...input }) {
      const started = Date.now();
      const timeout = AbortSignal.timeout(timeoutMs);
      let payload: unknown;
      try {
        const response = await fetch(geminiTranscribeUrl(model), {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(geminiTranscribeBody(input)),
          signal: AbortSignal.any([signal, timeout]),
        });
        if (!response.ok) throw await httpFailure(response);
        payload = await response.json();
      } catch (error) {
        if (error instanceof TranscriptionError) throw error;
        if (error instanceof SyntaxError) throw new TranscriptionError("invalid_response", { reason: "not_json" });
        throw transportFailure(error, signal, timeout);
      }
      const parsed = geminiResponseSchema.safeParse(payload);
      if (!parsed.success) throw new TranscriptionError("invalid_response", { reason: "unexpected_shape" });
      const usage = geminiUsage(parsed.data, model);
      console.info("Model usage", { step: "transcribe", provider: "gemini", model: usage.model, usage, ms: Date.now() - started });
      return { text: cleanTranscript(transcriptFrom(parsed.data), input.hint), usage };
    },
  };
}

export function geminiTranscriberFromEnv(env?: Readonly<Record<string, string | undefined>>): TranscriptionProvider | null {
  const config = geminiConfigFromEnv(env);
  return config ? createGeminiTranscriber(config) : null;
}
