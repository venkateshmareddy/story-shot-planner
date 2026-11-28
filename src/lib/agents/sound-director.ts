import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import {
  expertInstructions,
  CONTEXT_ACTION_CHARACTERS,
  CONTEXT_EMOTION_CHARACTERS,
  clip,
  type PlanShot,
  planExcerpt,
  SPECIALIST_MAX_OUTPUT_TOKENS,
  type SpecialistDefinition,
  specialistRole,
} from "./shared";

const fields = ["sound"] as const;

const spokenLine = ({ speaker, line, delivery }: PlanShot["dialogue"][number]) =>
  `${speaker}${delivery.trim() ? ` (${clip(delivery, 120)})` : ""}: ${clip(line, 240)}`;

export const soundDirector: SpecialistDefinition = {
  id: "sound-director",
  role: specialistRole("sound-director"),
  fields,
  contextCategories: ["sound", "dialogue", "locations", "genre", "intent"],
  schema: specialistOutput(fields),
  maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
  instructions: expertInstructions("sound-director"),
  buildContext: (plan: ShotPlan) => ({
    title: plan.title,
    intent: plan.intent,
    scenes: planExcerpt(
      plan,
      ({ sound }) => ({ sound }),
      (shot) => ({
        location: shot.location,
        action: clip(shot.action, CONTEXT_ACTION_CHARACTERS),
        emotion: clip(shot.emotion, CONTEXT_EMOTION_CHARACTERS),
        dialogue: shot.dialogue.map(spokenLine),
      }),
    ),
  }),
};
