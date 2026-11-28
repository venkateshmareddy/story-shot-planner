import { z } from "zod";
import { formatSchema } from "@/lib/formats";
import { collectedItem, MAX_INTERVIEW_TURNS, MAX_PLAN_ANSWERS } from "./interview";
import { storyContextSchema } from "./story-context-schema";
import {
  MAX_ANSWER_CHARACTERS,
  MAX_CHAT_HISTORY,
  MAX_CHAT_MESSAGE_CHARACTERS,
  MAX_FEEDBACK_CHARACTERS,
  MAX_STORY_CHARACTERS,
} from "./story-input";

const story = z.string().min(1).max(MAX_STORY_CHARACTERS).refine((text) => Boolean(text.trim()));
const feedback = z.string().trim().max(MAX_FEEDBACK_CHARACTERS);

export const interviewExchange = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().max(MAX_ANSWER_CHARACTERS),
});

export const planningRequest = z.discriminatedUnion("step", [
  z.object({ step: z.literal("draft"), story, feedback, format: formatSchema.optional() }),
  z.object({
    step: z.literal("interview"),
    story,
    answered: z.array(interviewExchange).max(MAX_INTERVIEW_TURNS).optional(),
    context: storyContextSchema.optional(),
    format: formatSchema.optional(),
  }),
  z.object({
    step: z.literal("plan"),
    story,
    answers: z.array(interviewExchange).max(MAX_PLAN_ANSWERS),
    collected: z.array(collectedItem).max(80).optional(),
    context: storyContextSchema.optional(),
    format: formatSchema.optional(),
  }),
]);

export const draftOutput = z.object({
  story: z.string(),
});

export const characterSchema = z.object({
  name: z.string(),
  role: z.string(),
  look: z.string(),
  personality: z.string(),
  voice: z.string(),
});

export const locationSchema = z.object({ name: z.string(), description: z.string() });

export const shotSchema = z.object({
  seconds: z.number(),
  framing: z.string(),
  camera: z.string(),
  characters: z.array(z.string()),
  location: z.string(),
  action: z.string(),
  dialogue: z.array(z.object({ speaker: z.string(), line: z.string(), delivery: z.string() })),
  emotion: z.string(),
  sound: z.string(),
});

export const sceneSchema = z.object({ title: z.string(), shots: z.array(shotSchema) });

export const planOutput = z.object({
  title: z.string(),
  logline: z.string(),
  intent: z.string(),
  characters: z.array(characterSchema),
  locations: z.array(locationSchema),
  scenes: z.array(sceneSchema),
  reviewNotes: z.array(z.string()),
});

/** Plans are written in parts so no single model call has to produce the whole plan. */
export const MAX_PLAN_SCENES = 20;

/** Part 1 of plan generation: everything except the shots. */
export const planOutlineOutput = z.object({
  title: z.string(),
  logline: z.string(),
  intent: z.string(),
  characters: z.array(characterSchema),
  locations: z.array(locationSchema),
  scenes: z.array(
    z.object({
      title: z.string(),
      /** What happens in the scene, in story order. */
      summary: z.string(),
      location: z.string(),
      characters: z.array(z.string()),
      /** Planned screen time for the scene. */
      seconds: z.number(),
    }),
  ),
  reviewNotes: z.array(z.string()),
});

/** Part 2 of plan generation: the shots of one scene (one call per scene, run in parallel). */
export const sceneShotsOutput = z.object({ shots: z.array(shotSchema) });

export const MAX_DECISIONS = 12;
/** Matches the interview's inline source limit plus the marker heading. */
export const MAX_REFINE_SOURCE_CHARACTERS = 26_000;

/** A resolved proposal fed back to the AI so rejected ideas are not re-proposed (DecisionRecord in agents/types). */
export const decisionRecord = z.object({
  status: z.enum(["accepted", "rejected"]),
  request: z.string().trim().max(300),
  changes: z.array(z.string().trim().max(200)).max(8),
});

export const refineRequest = z.object({
  plan: planOutput,
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "agent"]),
        text: z.string().min(1).max(MAX_CHAT_MESSAGE_CHARACTERS),
      }),
    )
    .max(MAX_CHAT_HISTORY),
  message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARACTERS),
  format: formatSchema.optional(),
  decisions: z.array(decisionRecord).max(MAX_DECISIONS).optional(),
  /** The filmmaker's imported story text (or its digest), so edits stay true to it. */
  source: z.string().trim().max(MAX_REFINE_SOURCE_CHARACTERS).optional(),
});

/**
 * One change to the scene list. `index` is the 0-based position in the plan as sent (before any edit);
 * insert_after with index -1 inserts before the first scene. `scene` is null only for remove.
 */
export const sceneEdit = z.object({
  action: z.enum(["replace", "insert_after", "remove"]),
  index: z.number().int(),
  scene: sceneSchema.nullable(),
});

/** Refine returns only what changed (null = unchanged), so output size tracks the change, not the plan. */
export const refineOutput = z.object({
  reply: z.string(),
  changeSummary: z.array(z.string()),
  title: z.string().nullable(),
  logline: z.string().nullable(),
  intent: z.string().nullable(),
  characters: z.array(characterSchema).nullable(),
  locations: z.array(locationSchema).nullable(),
  sceneEdits: z.array(sceneEdit),
  reviewNotes: z.array(z.string()).nullable(),
});

/** A name change applied in code everywhere it appears (names, who/where columns, speakers, text). */
export const renameSchema = z.object({ from: z.string(), to: z.string() });

/**
 * Chat edit, step 1: decide what changes. Overview fields are null when unchanged; `characters`/`locations` come back
 * complete (names already renamed) only when something beyond a rename changes. Scene content is written in step 2,
 * one call per entry in `sceneChanges` (index = 0-based position in the plan as sent; insert_after -1 = first).
 */
export const editPlanOutput = z.object({
  reply: z.string(),
  changeSummary: z.array(z.string()),
  renames: z.array(renameSchema),
  title: z.string().nullable(),
  logline: z.string().nullable(),
  intent: z.string().nullable(),
  characters: z.array(characterSchema).nullable(),
  locations: z.array(locationSchema).nullable(),
  reviewNotes: z.array(z.string()).nullable(),
  sceneChanges: z.array(
    z.object({
      action: z.enum(["rewrite", "insert_after", "remove"]),
      index: z.number().int(),
      /** What to change in that scene, or what the new scene shows; "" for remove. */
      instruction: z.string(),
    }),
  ),
});

/** Chat edit, step 2: one rewritten or new scene (parallel, one call each). */
export const sceneRewriteOutput = sceneSchema;

export const MAX_RENAMES = 10;

export type ShotPlan = z.infer<typeof planOutput>;
export type PlanOutline = z.infer<typeof planOutlineOutput>;
export type SceneEdit = z.infer<typeof sceneEdit>;
export type RefinePatch = z.infer<typeof refineOutput>;
export type EditPlan = z.infer<typeof editPlanOutput>;
export type Rename = z.infer<typeof renameSchema>;
export type RefineRequest = z.infer<typeof refineRequest>;
export type RefineMessage = RefineRequest["messages"][number];
