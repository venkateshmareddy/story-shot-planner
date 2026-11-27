import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import {
  clip,
  SPECIALIST_MAX_OUTPUT_TOKENS,
  type SpecialistDefinition,
  shotId,
  specialistInstructions,
} from "./shared";

const fields = ["sound"] as const;

export const soundDirector: SpecialistDefinition = {
  id: "sound-director",
  role: "Sound Director",
  fields,
  contextCategories: ["sound", "dialogue", "locations", "genre", "intent"],
  schema: specialistOutput(fields),
  maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
  instructions: specialistInstructions(
    "Sound Director",
    "You think like a professional sound designer and music supervisor: the soundtrack should carry emotion, place and transitions, and you flag where sound should lead or contrast the picture.",
    "Field: sound is shot-level and holds the complete sound design for the shot (ambience, effects, music, silence, mix emphasis).",
    {
      id: "sound-director",
      checklist:
        "dialogue clarity and delivery; ambience (the background sound of a place); Foley (recorded everyday sounds such as footsteps or cloth); sound effects; music; silence; sound transitions between shots and scenes; sound continuity and sync with the picture",
    },
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
