import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import { clip, type SpecialistDefinition, shotId, specialistInstructions } from "./shared";

const fields = ["logline", "intent", "sceneTitle", "action"] as const;

export const storyAnalyst: SpecialistDefinition = {
  id: "story-analyst",
  role: "Story Analyst",
  fields,
  schema: specialistOutput(fields),
  maxOutputTokens: 1_500,
  instructions: specialistInstructions(
    "Story Analyst",
    "You are a professional script editor. Assess dramatic structure, character motivation and arcs, conflict, stakes, theme, and whether the logline and intent are clear and every scene's action advances the story and earns its ending.",
    "Fields: logline and intent are plan-level (scene 1, shot null); sceneTitle is scene-level (shot null); action is shot-level. Keep action visual and filmable, and never add events the plan does not support.",
  ),
  buildContext: (plan: ShotPlan) => ({
    title: plan.title,
    logline: plan.logline,
    intent: plan.intent,
    characters: plan.characters.map(({ name, role, personality }) => ({
      name,
      role: clip(role, 200),
      personality: clip(personality, 200),
    })),
    scenes: plan.scenes.map((scene, sceneIndex) => ({
      scene: sceneIndex + 1,
      title: scene.title,
      shots: scene.shots.map((shot, shotIndex) => ({
        id: shotId(sceneIndex, shotIndex),
        action: clip(shot.action),
        emotion: clip(shot.emotion, 200),
        dialogue: shot.dialogue.map(({ speaker, line }) => `${speaker}: ${clip(line, 240)}`),
      })),
    })),
  }),
};
