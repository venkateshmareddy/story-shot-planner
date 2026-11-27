import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import { clip, type SpecialistDefinition, shotId, specialistInstructions } from "./shared";

const fields = ["seconds"] as const;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const sumSeconds = (shots: ShotPlan["scenes"][number]["shots"]) =>
  Math.round(shots.reduce((total, shot) => total + shot.seconds, 0) * 10) / 10;

export const editingDirector: SpecialistDefinition = {
  id: "editing-director",
  role: "Editor",
  fields,
  schema: specialistOutput(fields),
  maxOutputTokens: 1_200,
  instructions: specialistInstructions(
    "Editor",
    "You are a professional film editor. Judge pacing, rhythm, shot duration, cut points, transitions and sequence order against each shot's action, emotion and spoken words (about 2.5 words per second), and protect the film's total runtime.",
    'Field: seconds is shot-level; value is the new duration as a plain positive number such as "3.5". Put transitions, cut points and reordering ideas in recommendations.',
  ),
  buildContext: (plan: ShotPlan) => ({
    title: plan.title,
    intent: plan.intent,
    totalSeconds: Math.round(plan.scenes.reduce((total, scene) => total + sumSeconds(scene.shots), 0) * 10) / 10,
    scenes: plan.scenes.map((scene, sceneIndex) => ({
      scene: sceneIndex + 1,
      title: scene.title,
      seconds: sumSeconds(scene.shots),
      shots: scene.shots.map((shot, shotIndex) => ({
        id: shotId(sceneIndex, shotIndex),
        seconds: shot.seconds,
        action: clip(shot.action, 240),
        emotion: clip(shot.emotion, 160),
        spokenWords: shot.dialogue.reduce((total, { line }) => total + wordCount(line), 0),
      })),
    })),
  }),
};
