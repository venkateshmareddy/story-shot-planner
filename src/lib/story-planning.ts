import { z } from "zod";
import { MAX_ANSWER_CHARACTERS, MAX_FEEDBACK_CHARACTERS, MAX_STORY_CHARACTERS } from "./story-input";

const story = z.string().min(1).max(MAX_STORY_CHARACTERS).refine((text) => Boolean(text.trim()));
const feedback = z.string().trim().max(MAX_FEEDBACK_CHARACTERS);

export const planningRequest = z.discriminatedUnion("step", [
  z.object({ step: z.literal("draft"), story, feedback }),
  z.object({ step: z.literal("interview"), story }),
  z.object({
    step: z.literal("plan"),
    story,
    answers: z.array(z.object({
      question: z.string().trim().min(1).max(500),
      answer: z.string().trim().max(MAX_ANSWER_CHARACTERS),
    })).min(1).max(4),
  }),
]);

export const draftOutput = z.object({
  story: z.string(),
  reason: z.string(),
});

export const interviewOutput = z.object({
  questions: z.array(z.string()),
});

export const planOutput = z.object({
  title: z.string(),
  logline: z.string(),
  intent: z.string(),
  characters: z.array(z.object({
    name: z.string(),
    role: z.string(),
    look: z.string(),
    personality: z.string(),
    voice: z.string(),
  })),
  locations: z.array(z.object({ name: z.string(), description: z.string() })),
  scenes: z.array(z.object({
    title: z.string(),
    shots: z.array(z.object({
      seconds: z.number(),
      framing: z.string(),
      camera: z.string(),
      characters: z.array(z.string()),
      location: z.string(),
      action: z.string(),
      dialogue: z.array(z.object({ speaker: z.string(), line: z.string(), delivery: z.string() })),
      emotion: z.string(),
      sound: z.string(),
    })),
  })),
  reviewNotes: z.array(z.string()),
});

export type PlanningRequest = z.infer<typeof planningRequest>;
export type StoryDraft = z.infer<typeof draftOutput>;
export type ShotPlan = z.infer<typeof planOutput>;
