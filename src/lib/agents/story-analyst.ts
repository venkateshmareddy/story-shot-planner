import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import {
  expertInstructions,
  CONTEXT_EMOTION_CHARACTERS,
  clip,
  planExcerpt,
  SPECIALIST_MAX_OUTPUT_TOKENS,
  type SpecialistDefinition,
  specialistRole,
} from "./shared";

const fields = ["logline", "intent", "sceneTitle", "action"] as const;

export const storyAnalyst: SpecialistDefinition = {
  id: "story-analyst",
  role: specialistRole("story-analyst"),
  fields,
  contextCategories: ["concept", "genre", "audience", "characters", "relationships", "structure", "intent", "dialogue"],
  schema: specialistOutput(fields),
  maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
  readsSource: true,
  instructions: expertInstructions("story-analyst"),
  buildContext: (plan: ShotPlan) => ({
    title: plan.title,
    logline: plan.logline,
    intent: plan.intent,
    characters: plan.characters.map(({ name, role, personality }) => ({
      name,
      role: clip(role, 200),
      personality: clip(personality, 200),
    })),
    scenes: planExcerpt(
      plan,
      (shot) => ({ action: clip(shot.action) }),
      (shot) => ({
        emotion: clip(shot.emotion, CONTEXT_EMOTION_CHARACTERS),
        dialogue: shot.dialogue.map(({ speaker, line }) => `${speaker}: ${clip(line, 240)}`),
      }),
    ),
  }),
};
