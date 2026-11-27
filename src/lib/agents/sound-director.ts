import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import { clip, type SpecialistDefinition, shotId, specialistInstructions } from "./shared";

const fields = ["sound"] as const;

export const soundDirector: SpecialistDefinition = {
  id: "sound-director",
  role: "Sound Director",
  fields,
  schema: specialistOutput(fields),
  maxOutputTokens: 1_200,
  instructions: specialistInstructions(
    "Sound Director",
    "You are a professional sound designer and music supervisor. Shape ambience, Foley, effects, score, silence and dialogue clarity so the soundtrack carries emotion, place and transitions, and flag where sound should lead or contrast the picture.",
    "Field: sound is shot-level and holds the complete sound design for the shot (ambience, effects, music, silence, mix emphasis).",
  ),
  buildContext: (plan: ShotPlan) => ({
    title: plan.title,
    intent: plan.intent,
    scenes: plan.scenes.map((scene, sceneIndex) => ({
      scene: sceneIndex + 1,
      title: scene.title,
      shots: scene.shots.map((shot, shotIndex) => ({
        id: shotId(sceneIndex, shotIndex),
        location: shot.location,
        action: clip(shot.action),
        emotion: clip(shot.emotion, 200),
        sound: shot.sound,
        dialogue: shot.dialogue.map(({ speaker, line, delivery }) => ({
          speaker,
          line: clip(line, 240),
          delivery: clip(delivery, 120),
        })),
      })),
    })),
  }),
};
