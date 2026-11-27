import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import { clip, type SpecialistDefinition, shotId, specialistInstructions } from "./shared";

const fields = ["logline", "intent", "sceneTitle", "action"] as const;

export const storyAnalyst: SpecialistDefinition = {
  id: "story-analyst",
  role: "Story Analyst",
  fields,
  contextCategories: ["concept", "genre", "audience", "characters", "relationships", "structure", "intent", "dialogue"],
  schema: specialistOutput(fields),
  maxOutputTokens: 1_800,
  instructions: specialistInstructions(
    "Story Analyst",
    "You read the plan like a professional script editor: does every scene earn its place, do the characters want something the audience can feel, and does the ending pay off what the opening set up?",
    "Fields: logline and intent are plan-level (scene 1, shot null); sceneTitle is scene-level (shot null); action is shot-level. Keep action visual and filmable, and never add events the plan does not support.",
    {
      id: "story-analyst",
      checklist:
        "the dramatic purpose of each scene; character motivation; conflict and what is at risk; emotional progression across the film; each scene's objective; pacing and tension; narrative consistency; the plan's weakest points and a concrete fix for each",
    },
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
