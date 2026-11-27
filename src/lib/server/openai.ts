import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { STORY_MODEL } from "@/lib/models";
import { toUsageRecord, type UsageRecord, type UsageStep } from "@/lib/usage";

export { STORY_MODEL, TRANSCRIPTION_MODEL } from "@/lib/models";

export function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  return apiKey ? new OpenAI({ apiKey, maxRetries: 0, timeout: 90_000 }) : null;
}

export type ModelCall = {
  step: UsageStep;
  instructions: string;
  input: string;
  schema: z.ZodType;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Overrides the client's default request timeout for a call expected to run longer. */
  timeoutMs?: number;
};

/** Output is treated as unknown and re-validated by the caller. */
export type CallModel = (call: ModelCall) => Promise<{ output: unknown; usage: UsageRecord }>;

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

/** The one structured-output call path: real usage recorded, one metadata-only log line per call. */
export function createModelCaller(client: OpenAI): CallModel {
  return async ({ step, instructions, input, schema, maxOutputTokens, signal, timeoutMs }) => {
    const started = Date.now();
    const response = await client.responses.parse(
      {
        model: STORY_MODEL,
        store: false,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        text: { format: zodTextFormat(schema, step) },
      },
      timeoutMs ? { signal, timeout: timeoutMs } : { signal },
    );
    const model = response.model || STORY_MODEL;
    const usage = toUsageRecord(step, model, response.usage);
    const reason = unusableReason(response);
    console.info("Model usage", { step, model, usage, ms: Date.now() - started, ...(reason ? { reason } : {}) });
    if (reason) throw new ModelOutputError("Incomplete model result", usage, reason);
    return { output: response.output_parsed, usage };
  };
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
