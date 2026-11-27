import { z } from "zod";
import { collectedItem, MAX_INTERVIEW_TURNS } from "@/lib/interview";
import { interviewExchange, refineRequest } from "@/lib/story-planning";

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

export const directorRequest = refineRequest.pick({ plan: true, messages: true, message: true }).extend({
  answers: z.array(interviewExchange).max(MAX_INTERVIEW_TURNS).optional(),
  collected: z.array(collectedItem).max(40).optional(),
});
