import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import {
  expertInstructions,
  CONTEXT_ACTION_CHARACTERS,
  CONTEXT_EMOTION_CHARACTERS,
  clip,
  planExcerpt,
  SPECIALIST_MAX_OUTPUT_TOKENS,
  type SpecialistDefinition,
  specialistRole,
} from "./shared";

const fields = ["seconds"] as const;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const sumSeconds = (shots: ShotPlan["scenes"][number]["shots"]) =>
  Math.round(shots.reduce((total, shot) => total + shot.seconds, 0) * 10) / 10;

export const editingDirector: SpecialistDefinition = {
  id: "editing-director",
  role: specialistRole("editing-director"),
  fields,
  contextCategories: ["format", "structure", "scenes", "shots", "intent", "genre"],
  schema: specialistOutput(fields),
  maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
  instructions: expertInstructions("editing-director"),
  buildContext: (plan: ShotPlan) => ({
    title: plan.title,
    intent: plan.intent,
    totalSeconds: Math.round(plan.scenes.reduce((total, scene) => total + sumSeconds(scene.shots), 0) * 10) / 10,
    scenes: planExcerpt(
      plan,
      ({ seconds }) => ({ seconds }),
      (shot) => ({
        action: clip(shot.action, CONTEXT_ACTION_CHARACTERS),
        emotion: clip(shot.emotion, CONTEXT_EMOTION_CHARACTERS),
        spokenWords: shot.dialogue.reduce((total, { line }) => total + wordCount(line), 0) || undefined,
      }),
      (scene) => ({ sceneSeconds: sumSeconds(scene.shots) }),
    ),
  }),
};
