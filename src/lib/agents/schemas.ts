import { z } from "zod";
import { collectedItem, MAX_PLAN_ANSWERS } from "@/lib/interview";
import { storyContextSchema } from "@/lib/story-context-schema";
import { decisionRecord, interviewExchange, MAX_DECISIONS, refineRequest } from "@/lib/story-planning";
import type { ImageReference } from "./types";

export const EDIT_FIELDS = [
  "logline",
  "intent",
  "sceneTitle",
  "action",
  "framing",
  "camera",
  "sound",
  "seconds",
  "location",
  "characters",
] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

export const PLAN_LEVEL_FIELDS: readonly EditField[] = ["logline", "intent"];
export const SCENE_LEVEL_FIELDS: readonly EditField[] = ["sceneTitle"];

export const recommendationOutput = z.object({
  target: z.string(),
  issue: z.string(),
  recommendation: z.string(),
  rationale: z.string(),
  priority: z.enum(["high", "medium", "low"]),
});

function outputShape<T extends z.ZodType>(field: T) {
  return z.object({
    summary: z.string(),
    recommendations: z.array(recommendationOutput),
    edits: z.array(
      z.object({
        scene: z.number().int().min(1),
        shot: z.number().int().min(1).nullable(),
        field,
        value: z.string(),
      }),
    ),
  });
}

/** Structured-output schema for one specialist: edits may only name that specialist's fields. */
export function specialistOutput<const F extends readonly [EditField, ...EditField[]]>(fields: F) {
  return outputShape(z.enum(fields));
}

/** Server-side validation: any field name passes here; ownership is enforced when edits are sanitised. */
export const anySpecialistOutput = outputShape(z.string());
export type SpecialistOutput = z.infer<typeof anySpecialistOutput>;
export type SpecialistEdit = SpecialistOutput["edits"][number];

export const synthesisOutput = z.object({
  reply: z.string(),
  conflicts: z.array(z.string()),
});

export const IMAGE_REFERENCE_TEXT_MAX = 1_200;
export const IMAGE_REFERENCE_NAME_MAX = 120;
export const MAX_IMAGE_REFERENCES = 6;

const referenceText = z.string().max(IMAGE_REFERENCE_TEXT_MAX);

export const imageReference = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(IMAGE_REFERENCE_NAME_MAX),
  summary: referenceText,
  composition: referenceText,
  lighting: referenceText,
  cameraAngle: referenceText,
  colour: referenceText,
  environment: referenceText,
  mood: referenceText,
  shotIdeas: referenceText,
}) satisfies z.ZodType<ImageReference>;

export const directorRequest = refineRequest.pick({ plan: true, messages: true, message: true, source: true }).extend({
  answers: z.array(interviewExchange).max(MAX_PLAN_ANSWERS).optional(),
  collected: z.array(collectedItem).max(40).optional(),
  references: z.array(imageReference).max(MAX_IMAGE_REFERENCES).optional(),
  context: storyContextSchema.optional(),
  decisions: z.array(decisionRecord).max(MAX_DECISIONS).optional(),
  intent: z.literal("edit").optional(),
});
