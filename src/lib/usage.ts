export type UsageStep = "draft" | "interview" | "plan" | "refine" | "transcribe";

export type UsageRecord = {
  step: UsageStep;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function toUsageRecord(step: UsageStep, model: string, usage: unknown): UsageRecord {
  const source = (usage ?? {}) as Record<string, unknown>;
  const inputTokens = count(source.input_tokens) || count(source.prompt_tokens);
  const outputTokens = count(source.output_tokens) || count(source.completion_tokens);
  const totalTokens = count(source.total_tokens) || inputTokens + outputTokens;
  return { step, model, inputTokens, outputTokens, totalTokens };
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.step === "string" &&
    typeof record.model === "string" &&
    typeof record.inputTokens === "number" &&
    typeof record.outputTokens === "number" &&
    typeof record.totalTokens === "number"
  );
}
