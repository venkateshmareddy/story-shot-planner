export type UsageStep =
  | "draft"
  | "interview"
  | "plan"
  | "refine"
  | "transcribe"
  | "orchestrator"
  | "story-analyst"
  | "cinematography-director"
  | "sound-director"
  | "editing-director"
  | "continuity-reviewer"
  | "image-analysis"
  | "digest"
  | "ideas"
  | "originality"
  /** A Wikipedia reference lookup: an external request with no model tokens (model "wikipedia"). */
  | "originality-lookup"
  | "engagement";

export type UsageRecord = {
  step: UsageStep;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Part of inputTokens served from OpenAI's prompt cache (billed at a discount). Absent on older records. */
  cachedTokens?: number;
  /** Part of inputTokens written to the prompt cache (billed at a premium). Absent when nothing was written. */
  cacheWriteTokens?: number;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function toUsageRecord(step: UsageStep, model: string, usage: unknown): UsageRecord {
  const source = (usage ?? {}) as Record<string, unknown>;
  const inputTokens = count(source.input_tokens) || count(source.prompt_tokens);
  const outputTokens = count(source.output_tokens) || count(source.completion_tokens);
  const totalTokens = count(source.total_tokens) || inputTokens + outputTokens;
  const details = (source.input_tokens_details ?? source.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cachedTokens = Math.min(count(details.cached_tokens), inputTokens);
  const cacheWriteTokens = Math.min(count(details.cache_write_tokens), inputTokens);
  return {
    step,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedTokens ? { cachedTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.step === "string" &&
    typeof record.model === "string" &&
    typeof record.inputTokens === "number" &&
    typeof record.outputTokens === "number" &&
    typeof record.totalTokens === "number" &&
    (record.cachedTokens === undefined || typeof record.cachedTokens === "number") &&
    (record.cacheWriteTokens === undefined || typeof record.cacheWriteTokens === "number")
  );
}

/** One record for a user action that took several model calls; models are the distinct ones the responses named. */
export function sumUsage(step: UsageStep, records: readonly UsageRecord[]): UsageRecord {
  const total = (key: "inputTokens" | "outputTokens" | "totalTokens" | "cachedTokens" | "cacheWriteTokens") =>
    records.reduce((sum, record) => sum + count(record[key]), 0);
  const model = [...new Set(records.map((record) => record.model).filter(Boolean))].join(", ");
  const cachedTokens = total("cachedTokens");
  const cacheWriteTokens = total("cacheWriteTokens");
  return {
    step,
    model,
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    totalTokens: total("totalTokens"),
    ...(cachedTokens ? { cachedTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}
