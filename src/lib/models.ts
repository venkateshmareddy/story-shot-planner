import { z } from "zod";

export const STORY_MODEL = "gpt-6.2-sol";
export const TRANSCRIPTION_MODEL = "gpt-transcribe";

export const STORY_MODEL_HEADER = "x-story-model";
export const VOICE_MODEL_HEADER = "x-voice-model";
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,80}$/;
export const MAX_MODEL_OPTIONS = 200;

export const MODEL_KINDS = ["story", "voice"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const modelIdSchema = z.string().regex(MODEL_ID_PATTERN);

export const CATALOG_STATUSES = ["ok", "no_key", "forbidden", "unavailable"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

const catalogEntryShape = {
  default: modelIdSchema,
  options: z.array(z.object({ id: modelIdSchema })).max(MAX_MODEL_OPTIONS),
  status: z.enum(CATALOG_STATUSES),
  message: z.string().max(300),
};

export const storyCatalogSchema = z.object(catalogEntryShape);
export const voiceCatalogSchema = z.object({ provider: z.literal("gemini"), configured: z.boolean(), ...catalogEntryShape });
export const modelCatalogSchema = z.object({ story: storyCatalogSchema, voice: voiceCatalogSchema });

export type StoryCatalog = z.infer<typeof storyCatalogSchema>;
export type VoiceCatalog = z.infer<typeof voiceCatalogSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export const modelTestRequestSchema = z.object({ kind: z.enum(MODEL_KINDS), model: modelIdSchema }).strict();
export type ModelTestRequest = z.infer<typeof modelTestRequestSchema>;

const tokenCount = z.number().int().nonnegative();
export const modelTestUsageSchema = z.object({
  model: z.string().max(120),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  totalTokens: tokenCount,
});

export const MODEL_CHECK_REASONS = [
  "busy",
  "no_access",
  "unsupported",
  "rate_limit",
  "timeout",
  "unreachable",
  "not_set_up",
] as const;
export type ModelCheckReason = (typeof MODEL_CHECK_REASONS)[number];
export const modelCheckReasonSchema = z.enum(MODEL_CHECK_REASONS);

export const modelTestResponseSchema = z.object({
  ok: z.boolean(),
  ms: z.number().int().nonnegative(),
  message: z.string().max(300),
  reason: modelCheckReasonSchema.optional(),
  usage: modelTestUsageSchema.optional(),
});
export type ModelTestResponse = z.infer<typeof modelTestResponseSchema>;
