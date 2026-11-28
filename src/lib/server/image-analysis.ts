import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInput } from "openai/resources/responses/responses";
import { z } from "zod";
import { IMAGE_REFERENCE_NAME_MAX, IMAGE_REFERENCE_TEXT_MAX } from "@/lib/agents/schemas";
import { clip } from "@/lib/agents/shared";
import type { ImageAnalysisResponse, ImageReference } from "@/lib/agents/types";
import { STORY_MODEL } from "@/lib/models";
import { brainSections } from "@/lib/server/brain";
import { cacheWriteTokens, logModelUsage, modelRequest } from "@/lib/server/openai";
import { PLAIN_LANGUAGE, SOURCE_RULES } from "@/lib/server/prompts";
import { toUsageRecord } from "@/lib/usage";

export const MAX_IMAGE_BYTES = 4_000_000;
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS = 900;
export const DEFAULT_REFERENCE_NAME = "Reference image";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const imageAnalysisOutput = z.object({
  summary: z.string(),
  composition: z.string(),
  lighting: z.string(),
  cameraAngle: z.string(),
  colour: z.string(),
  environment: z.string(),
  mood: z.string(),
  shotIdeas: z.string(),
});
export type ImageAnalysisOutput = z.infer<typeof imageAnalysisOutput>;

const IMAGE_BRAIN = brainSections("helpers/IMAGE.md");

export const IMAGE_ANALYSIS_INSTRUCTIONS = [SOURCE_RULES, IMAGE_BRAIN.identity, PLAIN_LANGUAGE, IMAGE_BRAIN.task].join("\n");

const IMAGE_ANALYSIS_PROMPT = "Analyse this reference image for the film.";

export function imageTypeFromHeader(header: string | null | undefined): ImageType | null {
  const type = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (IMAGE_TYPES as readonly string[]).includes(type) ? (type as ImageType) : null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  return bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Rejects mislabelled or non-image bytes before they cost a model call. */
export function matchesImageType(bytes: Uint8Array, type: ImageType) {
  if (type === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
}

export function referenceName(header: string | null | undefined) {
  let name = header ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {}
  return clip(name.replace(/\p{Cc}/gu, " "), IMAGE_REFERENCE_NAME_MAX) || DEFAULT_REFERENCE_NAME;
}

export function buildImageInput(bytes: Uint8Array, type: ImageType) {
  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: IMAGE_ANALYSIS_PROMPT },
        { type: "input_image", image_url: `data:${type};base64,${base64}`, detail: "low" },
      ],
    },
  ] satisfies ResponseInput;
}

export function toImageReference(output: ImageAnalysisOutput, name: string, id: string): ImageReference {
  const text = (value: string) => clip(value, IMAGE_REFERENCE_TEXT_MAX);
  return {
    id,
    name,
    summary: text(output.summary),
    composition: text(output.composition),
    lighting: text(output.lighting),
    cameraAngle: text(output.cameraAngle),
    colour: text(output.colour),
    environment: text(output.environment),
    mood: text(output.mood),
    shotIdeas: text(output.shotIdeas),
  };
}

/** True when the model rejected the image input itself (e.g. a text-only model), not the key or quota. */
export function isImageInputRejected(error: unknown) {
  if (!(error instanceof OpenAI.APIError) || (error.status !== 400 && error.status !== 422)) return false;
  return /image|vision/i.test(`${error.message} ${error.code ?? ""} ${error.param ?? ""}`);
}

export class IncompleteImageAnalysisError extends Error {}

export async function analyseImage(
  client: Pick<OpenAI, "responses">,
  image: Uint8Array,
  type: ImageType,
  name: string,
): Promise<ImageAnalysisResponse> {
  const format = zodTextFormat(imageAnalysisOutput, "image_analysis");
  const response = await client.responses.parse(
    modelRequest("image-analysis", {
      instructions: IMAGE_ANALYSIS_INSTRUCTIONS,
      input: buildImageInput(image, type),
      format,
      maxOutputTokens: IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS,
    }),
  );
  const usage = toUsageRecord("image-analysis", STORY_MODEL, response.usage);
  logModelUsage({
    step: "image-analysis",
    stage: "image-analysis",
    model: STORY_MODEL,
    usage,
    cacheWriteTokens: cacheWriteTokens(response.usage),
  });
  if (response.status !== "completed" || !response.output_parsed?.summary.trim()) {
    throw new IncompleteImageAnalysisError("Incomplete image analysis");
  }
  return { reference: toImageReference(response.output_parsed, name, crypto.randomUUID()), usage };
}
