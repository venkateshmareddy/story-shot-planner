import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  type CatalogStatus,
  MAX_MODEL_OPTIONS,
  MODEL_ID_PATTERN,
  type ModelCatalog,
  type ModelCheckReason,
  type ModelKind,
  type ModelTestResponse,
  modelTestUsageSchema,
  STORY_MODEL,
  STORY_MODEL_HEADER,
  type StoryCatalog,
  VOICE_MODEL_HEADER,
  type VoiceCatalog,
} from "@/lib/models";
import { deadline, modelRequest, NO_PROMPT_CACHE } from "@/lib/server/openai";
import { createGeminiTranscriber, type GeminiConfig } from "@/lib/server/transcription/gemini";
import { TranscriptionError, type TranscriptionProvider } from "@/lib/server/transcription/provider";
import { transcriptMatchesSample, voiceSample } from "@/lib/server/voice-sample";
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL, EMPTY_HINT } from "@/lib/transcription";

export const DEFAULT_VOICE_MODEL = DEFAULT_GEMINI_TRANSCRIBE_MODEL;
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
export const LIST_TIMEOUT_MS = 8_000;
export const TEST_TIMEOUT_MS = 15_000;
export const VOICE_TEST_TIMEOUT_MS = 25_000;
export const MAX_GEMINI_PAGES = 5;
// Reasoning models count their thinking toward this cap; a tighter one ends them before the answer.
export const STORY_TEST_MAX_OUTPUT_TOKENS = 512;

const FAMILY: Record<ModelKind, { include: RegExp; exclude: RegExp }> = {
  story: {
    include: /^(gpt-|o\d)/,
    // Legacy ids can't return structured output, which every studio request needs.
    exclude:
      /embed|tts|whisper|transcri|audio|realtime|image|dall-e|moderation|search|computer-use|instruct|deep-research|codex|^gpt-3\.5|^gpt-4(-|$)|^o1-(mini|preview)/i,
  },
  voice: {
    include: /^gemini-/,
    exclude: /embed|tts|image|live|native-audio|computer-use|robotics/i,
  },
};

const ALLOWLIST_ENV: Record<ModelKind, string> = { story: "ALLOWED_STORY_MODELS", voice: "ALLOWED_VOICE_MODELS" };

export const NOT_SET_UP: Record<ModelKind, string> = {
  story: "Not set up — add OPENAI_API_KEY to the server’s .env file.",
  voice: "Not set up — add GEMINI_API_KEY to the server’s .env file.",
};

const CATALOG_MESSAGES: Record<ModelKind, Record<Exclude<CatalogStatus, "no_key">, string>> = {
  story: {
    ok: "Listed live from your OpenAI account.",
    forbidden: "OpenAI refused the API key. Check OPENAI_API_KEY in the server’s .env file.",
    unavailable: "Couldn’t load the list from OpenAI. Try Refresh.",
  },
  voice: {
    ok: "Listed live from your Google AI account.",
    forbidden: "Google refused the API key. Check GEMINI_API_KEY in the server’s .env file.",
    unavailable: "Couldn’t load the list from Google. Try Refresh.",
  },
};

export const TEST_MESSAGES = {
  key: "Your API key can’t use this model. Pick another one or check the key.",
  unsupported: "This model can’t handle the studio’s requests. Pick another one.",
  misheard: "This model answered, but didn’t turn the test recording into the right words. Pick another one.",
  busy: "The model is busy right now (high demand). Try again later.",
  limit: "Your API key has reached a rate or usage limit. Try again later.",
  timeout: "The model didn’t answer in time. Try again.",
  unreachable: "The model couldn’t be reached. Try again.",
} as const;

export function geminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

export function defaultModel(kind: ModelKind): string {
  return kind === "story" ? STORY_MODEL : process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || DEFAULT_VOICE_MODEL;
}

/** The id shape and model family the studio can use for this job, before any account or allowlist check. */
export function isModelFamily(kind: ModelKind, id: string): boolean {
  const { include, exclude } = FAMILY[kind];
  return MODEL_ID_PATTERN.test(id) && include.test(id) && !exclude.test(id);
}

function allowlist(kind: ModelKind): ReadonlySet<string> | null {
  const ids = (process.env[ALLOWLIST_ENV[kind]] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/** The server's default is always allowed; anything else must be in the family and, when one is set, the allowlist. */
export function isAllowedModel(kind: ModelKind, id: string): boolean {
  if (id === defaultModel(kind)) return true;
  if (!isModelFamily(kind, id)) return false;
  const allowed = allowlist(kind);
  return !allowed || allowed.has(id);
}

export function resolveModel(kind: ModelKind, requested: string | null | undefined): string {
  const id = requested?.trim();
  return id && isAllowedModel(kind, id) ? id : defaultModel(kind);
}

type WithHeaders = Pick<Request, "headers">;

export function resolveStoryModel(request: WithHeaders): string {
  return resolveModel("story", request.headers.get(STORY_MODEL_HEADER));
}

export function resolveVoiceModel(request: WithHeaders): string {
  return resolveModel("voice", request.headers.get(VOICE_MODEL_HEADER));
}

/** Allowed ids only, de-duplicated, the default first and the rest in natural order, capped. */
export function catalogOptions(kind: ModelKind, ids: readonly string[]): { id: string }[] {
  const fallback = defaultModel(kind);
  const allowed = [...new Set(ids)].filter((id) => isAllowedModel(kind, id));
  allowed.sort((a, b) => {
    if (a === fallback || b === fallback) return a === fallback ? -1 : 1;
    return a.localeCompare(b, "en", { numeric: true });
  });
  return allowed.slice(0, MAX_MODEL_OPTIONS).map((id) => ({ id }));
}

function storyEntry(status: CatalogStatus, ids: readonly string[] = []): StoryCatalog {
  return {
    default: defaultModel("story"),
    options: status === "ok" ? catalogOptions("story", ids) : [],
    status,
    message: status === "no_key" ? NOT_SET_UP.story : CATALOG_MESSAGES.story[status],
  };
}

function voiceEntry(status: CatalogStatus, configured: boolean, ids: readonly string[] = []): VoiceCatalog {
  return {
    provider: "gemini",
    configured,
    default: defaultModel("voice"),
    options: status === "ok" ? catalogOptions("voice", ids) : [],
    status,
    message: status === "no_key" ? NOT_SET_UP.voice : CATALOG_MESSAGES.voice[status],
  };
}

const listFailure = (status: number | undefined): CatalogStatus =>
  status === 400 || status === 401 || status === 403 ? "forbidden" : "unavailable";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

const openAIModelList = z.array(z.object({ id: z.string() }));

export async function listStoryModels(
  client: Pick<OpenAI, "models"> | null,
  { signal }: { signal?: AbortSignal } = {},
): Promise<StoryCatalog> {
  if (!client) return storyEntry("no_key");
  try {
    const page = await client.models.list({ signal, timeout: LIST_TIMEOUT_MS });
    const parsed = openAIModelList.safeParse(page.data);
    if (!parsed.success) {
      console.warn("Model list failed", { provider: "openai", error: "unexpected_shape" });
      return storyEntry("unavailable");
    }
    return storyEntry(
      "ok",
      parsed.data.map((model) => model.id),
    );
  } catch (error) {
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    console.warn("Model list failed", { provider: "openai", status, error: errorName(error) });
    return storyEntry(listFailure(status));
  }
}

const geminiModelPage = z.object({
  models: z
    .array(z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() }))
    .optional(),
  nextPageToken: z.string().optional(),
});

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;

type ProviderOptions = { fetch?: ProviderFetch; signal?: AbortSignal };

export async function listVoiceModels(
  apiKey: string | null,
  { fetch = globalThis.fetch, signal }: ProviderOptions = {},
): Promise<VoiceCatalog> {
  if (!apiKey) return voiceEntry("no_key", false);
  const timeout = deadline(signal, LIST_TIMEOUT_MS);
  const ids: string[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_GEMINI_PAGES; page++) {
      const url = new URL(`${GEMINI_API_URL}/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url.href, { headers: { "x-goog-api-key": apiKey }, signal: timeout });
      if (!response.ok) {
        await response.body?.cancel();
        console.warn("Model list failed", { provider: "gemini", status: response.status });
        return voiceEntry(listFailure(response.status), true);
      }
      const parsed = geminiModelPage.safeParse(await response.json());
      if (!parsed.success) {
        console.warn("Model list failed", { provider: "gemini", error: "unexpected_shape" });
        return voiceEntry("unavailable", true);
      }
      for (const model of parsed.data.models ?? []) {
        if (model.supportedGenerationMethods?.includes("generateContent")) ids.push(model.name.replace(/^models\//, ""));
      }
      pageToken = parsed.data.nextPageToken || undefined;
      if (!pageToken) break;
    }
  } catch (error) {
    console.warn("Model list failed", { provider: "gemini", error: errorName(error) });
    return voiceEntry("unavailable", true);
  }
  return voiceEntry("ok", true, ids);
}

export type CatalogSources = {
  openai: Pick<OpenAI, "models"> | null;
  geminiKey: string | null;
  fetch?: ProviderFetch;
  signal?: AbortSignal;
};

/** Both providers in parallel; each settles on its own status, so one failing never hides the other. */
export async function loadModelCatalog({ openai, geminiKey, fetch, signal }: CatalogSources): Promise<ModelCatalog> {
  const [story, voice] = await Promise.all([
    listStoryModels(openai, { signal }),
    listVoiceModels(geminiKey, { fetch, signal }),
  ]);
  return { story, voice };
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(Date.now() - started));
}

export function worksMessage(ms: number): string {
  return `Works — ${(ms / 1_000).toFixed(1)} s`;
}

function isTimeout(error: unknown): boolean {
  return error instanceof OpenAI.APIConnectionTimeoutError || (error instanceof Error && error.name === "TimeoutError");
}

type CheckFailure = Exclude<ModelCheckReason, "not_set_up">;

export function failureReason(status: number | undefined, timedOut = false): CheckFailure {
  if (status === 401 || status === 403 || status === 404) return "no_access";
  if (status === 429) return "rate_limit";
  if (status === 503 || status === 529) return "busy";
  if (status === 400 || status === 422) return "unsupported";
  if (timedOut || status === 408 || status === 504) return "timeout";
  return "unreachable";
}

const REASON_MESSAGES: Record<CheckFailure, string> = {
  busy: TEST_MESSAGES.busy,
  no_access: TEST_MESSAGES.key,
  unsupported: TEST_MESSAGES.unsupported,
  rate_limit: TEST_MESSAGES.limit,
  timeout: TEST_MESSAGES.timeout,
  unreachable: TEST_MESSAGES.unreachable,
};

function notSetUp(kind: ModelKind): ModelTestResponse {
  return { ok: false, ms: 0, reason: "not_set_up", message: NOT_SET_UP[kind] };
}

function failed(reason: CheckFailure, ms: number, message = REASON_MESSAGES[reason]): ModelTestResponse {
  return { ok: false, ms, reason, message };
}

function passed(ms: number, usage: unknown): ModelTestResponse {
  const parsed = modelTestUsageSchema.safeParse(usage);
  return { ok: true, ms, message: worksMessage(ms), ...(parsed.success ? { usage: parsed.data } : {}) };
}

function logTest(kind: ModelKind, model: string, result: ModelTestResponse, status?: number) {
  console.info("Model test", {
    kind,
    model,
    ok: result.ok,
    ms: result.ms,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(status ? { status } : {}),
  });
}

const modelCheckOutput = z.object({ ok: z.boolean() });

const responseUsage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

/** Passes only on a completed structured answer that parses, the way every studio request is read. */
export async function testStoryModel(
  client: Pick<OpenAI, "responses"> | null,
  model: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ModelTestResponse> {
  if (!client) return notSetUp("story");
  const started = Date.now();
  let result: ModelTestResponse;
  let status: number | undefined;
  try {
    const response = await client.responses.parse(
      modelRequest(
        null,
        {
          instructions: "Connection check. Reply with ok set to true.",
          input: "Check",
          format: zodTextFormat(modelCheckOutput, "model_check"),
          maxOutputTokens: STORY_TEST_MAX_OUTPUT_TOKENS,
        },
        NO_PROMPT_CACHE,
        model,
      ),
      { signal, timeout: TEST_TIMEOUT_MS },
    );
    const ms = elapsed(started);
    const answer = modelCheckOutput.safeParse(response.output_parsed);
    const usage = responseUsage.safeParse(response.usage);
    result =
      response.status === "completed" && answer.success
        ? passed(
            ms,
            usage.success
              ? {
                  model: (response.model || model).slice(0, 120),
                  inputTokens: usage.data.input_tokens,
                  outputTokens: usage.data.output_tokens,
                  totalTokens: usage.data.total_tokens,
                }
              : undefined,
          )
        : failed("unsupported", ms);
  } catch (error) {
    status = error instanceof OpenAI.APIError ? error.status : undefined;
    const ms = elapsed(started);
    result = error instanceof SyntaxError ? failed("unsupported", ms) : failed(failureReason(status, isTimeout(error)), ms);
  }
  logTest("story", model, result, status);
  return result;
}

export type VoiceTranscriberFactory = (config: GeminiConfig) => Pick<TranscriptionProvider, "transcribe">;

const VOICE_FAILURES: Partial<Record<string, CheckFailure>> = {
  auth: "no_access",
  model: "no_access",
  unavailable: "no_access",
  rate_limited: "rate_limit",
  timeout: "timeout",
  bad_audio: "unsupported",
  blocked: "unsupported",
  too_long: "unsupported",
  no_speech: "unsupported",
  invalid_response: "unsupported",
};

function voiceFailureReason(error: unknown): CheckFailure {
  if (!(error instanceof TranscriptionError)) return isTimeout(error) ? "timeout" : "unreachable";
  const status = error.detail.status;
  if (status === 503 || status === 529) return "busy";
  return VOICE_FAILURES[error.failure] ?? failureReason(status);
}

/** Transcribes the bundled speech clip through the same provider as voice notes and checks the words that come back. */
export async function testVoiceModel(
  apiKey: string | null,
  model: string,
  {
    signal = new AbortController().signal,
    createTranscriber = createGeminiTranscriber,
  }: { signal?: AbortSignal; createTranscriber?: VoiceTranscriberFactory } = {},
): Promise<ModelTestResponse> {
  if (!apiKey) return notSetUp("voice");
  const started = Date.now();
  let result: ModelTestResponse;
  let status: number | undefined;
  try {
    const transcriber = createTranscriber({ apiKey, model, timeoutMs: VOICE_TEST_TIMEOUT_MS });
    const { text, usage } = await transcriber.transcribe({ audio: voiceSample(), format: "wav", hint: EMPTY_HINT, signal });
    const ms = elapsed(started);
    result = transcriptMatchesSample(text)
      ? passed(ms, {
          model: usage.model.slice(0, 120),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        })
      : failed("unsupported", ms, TEST_MESSAGES.misheard);
  } catch (error) {
    status = error instanceof TranscriptionError ? error.detail.status : undefined;
    result = failed(voiceFailureReason(error), elapsed(started));
  }
  logTest("voice", model, result, status);
  return result;
}
