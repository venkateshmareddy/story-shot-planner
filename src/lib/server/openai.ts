import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParams, ResponseInput, ResponseInputText } from "openai/resources/responses/responses";
import type { z } from "zod";
import { STORY_MODEL } from "@/lib/models";
import { type ModelStage, type ModelVerbosity, stageForStep, stageSettings } from "@/lib/server/model-settings";
import { toUsageRecord, type UsageRecord, type UsageStep } from "@/lib/usage";

export { STORY_MODEL, TRANSCRIPTION_MODEL } from "@/lib/models";

export function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  return apiKey ? new OpenAI({ apiKey, maxRetries: 0, timeout: 90_000 }) : null;
}

type PromptCacheOptions = ResponseCreateParams.PromptCacheOptions;

/** Explicit mode without a breakpoint: no cache reads or writes. Implicit mode bills a write on every call. */
export const NO_PROMPT_CACHE: PromptCacheOptions = { mode: "explicit" };
/** For a prefix written once by a prewarm and read by the calls after it; a 30m write costs half a 12h one. */
export const PREFIX_CACHE: PromptCacheOptions = { mode: "explicit", ttl: "30m" };
export const PREFIX_BREAKPOINT: ResponseInputText.PromptCacheBreakpoint = { mode: "explicit", ttl: "30m" };
export const PROMPT_CACHE_MIN_TOKENS = 1_024;
export const PREWARM_TIMEOUT_MS = 15_000;

type ModelInput = string | ResponseInput;

export type ModelRequestParts<Format, Input extends ModelInput> = {
  instructions: string;
  input: Input;
  format: Format;
  maxOutputTokens: number;
};

export type ModelRequest<Format, Input extends ModelInput> = {
  model: string;
  store: false;
  instructions: string;
  input: Input;
  max_output_tokens: number;
  text: { format: Format; verbosity?: ModelVerbosity };
  prompt_cache_options: PromptCacheOptions;
};

/** The one Responses request shape: the stage's settings applied and prompt caching off unless `cache` turns it on. */
export function modelRequest<Format, Input extends ModelInput>(
  stage: ModelStage | null,
  { instructions, input, format, maxOutputTokens }: ModelRequestParts<Format, Input>,
  cache: PromptCacheOptions = NO_PROMPT_CACHE,
  model: string = STORY_MODEL,
): ModelRequest<Format, Input> {
  const verbosity = stageSettings(stage)?.verbosity;
  return {
    model,
    store: false,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    text: verbosity ? { format, verbosity } : { format },
    prompt_cache_options: { ...cache },
  };
}

/** The prefix as its own content part ending at a cache breakpoint, then the rest. The model reads prefix + rest. */
export function prefixedInput(cachedPrefix: string, rest?: string): ResponseInput {
  const content: ResponseInputText[] = [
    { type: "input_text", text: cachedPrefix, prompt_cache_breakpoint: { ...PREFIX_BREAKPOINT } },
  ];
  if (rest) content.push({ type: "input_text", text: rest });
  return [{ role: "user", content }];
}

export function cacheWriteTokens(usage: unknown): number {
  const details = (usage as { input_tokens_details?: { cache_write_tokens?: unknown } } | null | undefined)
    ?.input_tokens_details;
  const written = details?.cache_write_tokens;
  return typeof written === "number" && Number.isFinite(written) && written > 0 ? written : 0;
}

/** The metadata-only "Model usage" log line, with prompt-cache reads and writes made explicit. */
export function logModelUsage(entry: {
  step: string;
  stage?: ModelStage | null;
  model: string;
  usage: UsageRecord;
  cacheWriteTokens?: number;
  ms?: number;
  reason?: string;
  prewarm?: true;
}) {
  console.info("Model usage", {
    ...entry,
    cachedTokens: entry.usage.cachedTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
  });
}

export type ModelCall = {
  step: UsageStep;
  /** Selects the request settings in MODEL_SETTINGS; defaults to the step's own stage. */
  stage?: ModelStage;
  instructions: string;
  input: string;
  /** Written by a prewarm and read from the cache: sent before `input` as its own part, ending at a breakpoint. */
  cachedPrefix?: string;
  schema: z.ZodType;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Overrides the client's default request timeout for a call expected to run longer. */
  timeoutMs?: number;
};

export type PrewarmCall = Omit<ModelCall, "input" | "cachedPrefix"> & { cachedPrefix: string };

type ResponsesClient = Pick<OpenAI, "responses">;

/** For helpers that build their own request: every `responses.parse` they make asks for `model` instead. */
export function pinStoryModel(client: ResponsesClient, model: string): ResponsesClient {
  if (model === STORY_MODEL) return client;
  const { responses } = client;
  type Parse = ResponsesClient["responses"]["parse"];
  const parse = ((body: Parameters<Parse>[0], options?: Parameters<Parse>[1]) =>
    responses.parse({ ...body, model }, options)) as Parse;
  const pinned: ResponsesClient["responses"] = Object.create(responses);
  return { responses: Object.assign(pinned, { parse }) };
}

/** Output is treated as unknown and re-validated by the caller. */
export type CallModel = {
  (call: ModelCall): Promise<{ output: unknown; usage: UsageRecord }>;
  /** Writes `cachedPrefix` to the prompt cache without generating output; rejects when nothing was cached. */
  prewarm?: (call: PrewarmCall) => Promise<UsageRecord>;
};

/** A model call that returned (and cost tokens) but produced no usable output. */
export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly usage: UsageRecord,
    readonly reason?: string,
  ) {
    super(reason ? `${message} (${reason})` : message);
    this.name = "ModelOutputError";
  }
}

/** Diagnostic metadata for a failed model call. Never carries prompt, story or output text. */
export type ModelErrorMetadata = {
  error: string;
  reason?: string;
  status?: number;
  code?: string;
  outputTokens?: number;
};

export function modelErrorMetadata(error: unknown): ModelErrorMetadata {
  const metadata: ModelErrorMetadata = { error: error instanceof Error ? error.name : typeof error };
  if (error instanceof ModelOutputError) {
    metadata.outputTokens = error.usage.outputTokens;
    if (error.reason) metadata.reason = error.reason;
  }
  if (error instanceof OpenAI.APIError) {
    if (error.status) metadata.status = error.status;
    if (error.code) metadata.code = error.code;
  }
  return metadata;
}

type ParsedResponseState = {
  status?: string;
  incomplete_details: { reason?: string } | null;
  output_parsed: unknown;
};

function unusableReason({ status, incomplete_details, output_parsed }: ParsedResponseState): string | null {
  if (status !== "completed") return incomplete_details?.reason ?? status ?? "unknown_status";
  return output_parsed ? null : "no_parsed_output";
}

export function deadline(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Settles on abort even if the callee ignores the signal. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const stageOf = (call: Pick<ModelCall, "step" | "stage">) => call.stage ?? stageForStep(call.step);

/** The one structured-output call path: real usage recorded, one metadata-only log line per call. */
export function createModelCaller(client: Pick<OpenAI, "responses">, model: string = STORY_MODEL): CallModel {
  const send = (call: ModelCall | PrewarmCall, input: ModelInput, cache: PromptCacheOptions) => {
    const { step, schema, signal, timeoutMs } = call;
    const format = zodTextFormat(schema, step);
    const { instructions, maxOutputTokens } = call;
    return client.responses.parse(
      modelRequest(stageOf(call), { instructions, input, format, maxOutputTokens }, cache, model),
      timeoutMs ? { signal, timeout: timeoutMs } : { signal },
    );
  };
  const callModel: CallModel = async (call) => {
    const { step, cachedPrefix, input } = call;
    const started = Date.now();
    const response = await (cachedPrefix
      ? send(call, prefixedInput(cachedPrefix, input), PREFIX_CACHE)
      : send(call, input, NO_PROMPT_CACHE));
    const answeredBy = response.model || model;
    const usage = toUsageRecord(step, answeredBy, response.usage);
    const reason = unusableReason(response);
    logModelUsage({
      step,
      stage: stageOf(call),
      model: answeredBy,
      usage,
      cacheWriteTokens: cacheWriteTokens(response.usage),
      ms: Date.now() - started,
      ...(reason ? { reason } : {}),
    });
    if (reason) throw new ModelOutputError("Incomplete model result", usage, reason);
    return { output: response.output_parsed, usage };
  };
  callModel.prewarm = async (call) => {
    const started = Date.now();
    const response = await send(call, prefixedInput(call.cachedPrefix), { ...PREFIX_CACHE, prewarm: true });
    const answeredBy = response.model || model;
    const usage = toUsageRecord(call.step, answeredBy, response.usage);
    const written = cacheWriteTokens(response.usage);
    const reason = written || usage.cachedTokens ? null : "no_cache_write";
    logModelUsage({
      step: call.step,
      stage: stageOf(call),
      model: answeredBy,
      usage,
      cacheWriteTokens: written,
      ms: Date.now() - started,
      prewarm: true,
      ...(reason ? { reason } : {}),
    });
    if (reason) throw new ModelOutputError("Prompt cache not written", usage, reason);
    return usage;
  };
  return callModel;
}

/** chars/4 with a 25% margin: a prefix under the cache minimum is never written, so prewarming it is pure cost. */
export function worthPrewarming(instructions: string, cachedPrefix: string, readers: number): boolean {
  const estimatedTokens = (instructions.length + cachedPrefix.length) / 4;
  return readers >= 2 && estimatedTokens >= PROMPT_CACHE_MIN_TOKENS * 1.25;
}

export type PrewarmResult = { cachedPrefix?: string; usage?: UsageRecord };

/**
 * Prewarms a prefix that `readers` parallel calls share. One 1.25× write then 0.05× reads beats full-price input from
 * two readers up. Never throws: on any failure the readers run uncached, so they don't each pay for a write.
 */
export async function prewarmPrefix(callModel: CallModel, call: PrewarmCall, readers: number): Promise<PrewarmResult> {
  if (!callModel.prewarm || !worthPrewarming(call.instructions, call.cachedPrefix, readers)) return {};
  try {
    const usage = await untilAborted(callModel.prewarm(call), call.signal);
    return { cachedPrefix: call.cachedPrefix, usage };
  } catch (error) {
    const metadata = modelErrorMetadata(error);
    console.warn("Prompt cache prewarm failed", { step: call.step, stage: stageOf(call), ...metadata });
    return error instanceof ModelOutputError ? { usage: error.usage } : {};
  }
}

export function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export function modelError(error: unknown, step: string) {
  const metadata = modelErrorMetadata(error);
  const { status } = metadata;
  console.warn("Model call failed", { step, ...metadata });
  if (status === 401 || status === 403 || status === 404) {
    return jsonError("Check that the team API key is valid and has access to this model.", 503);
  }
  if (status === 429) {
    return jsonError("The team API key has reached a rate or usage limit. Check the account before retrying.", 429);
  }
  return jsonError("The model couldn’t complete this step. Your input is still available to retry.", 502);
}
