import { z } from "zod";
import { formatSchema } from "@/lib/formats";
import { MAX_INTERVIEW_TURNS } from "./interview";
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
    format: formatSchema.optional(),
  }),
  z.object({
    step: z.literal("plan"),
    story,
    answers: z.array(interviewExchange).min(1).max(MAX_INTERVIEW_TURNS),
    format: formatSchema.optional(),
  }),
]);

export const draftOutput = z.object({
  story: z.string(),
  reason: z.string(),
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
});

export const refineOutput = z.object({
  reply: z.string(),
  changeSummary: z.array(z.string()),
  plan: planOutput,
});

export type ShotPlan = z.infer<typeof planOutput>;
export type RefineRequest = z.infer<typeof refineRequest>;
export type RefineMessage = RefineRequest["messages"][number];
