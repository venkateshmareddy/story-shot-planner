import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import { clip, type SpecialistDefinition, shotId, specialistInstructions } from "./shared";

const fields = ["location", "characters"] as const;

export const continuityReviewer: SpecialistDefinition = {
  id: "continuity-reviewer",
  role: "Script Supervisor",
  fields,
  schema: specialistOutput(fields),
  maxOutputTokens: 1_500,
  instructions: specialistInstructions(
    "Script Supervisor",
    "You are a professional script supervisor. Find continuity errors: characters who speak or act without being listed in the shot, inconsistent names, locations, props, costumes or appearance, timeline and time-of-day contradictions, and screen-geography problems.",
    "Fields: location is one location name, using an existing name exactly where one fits; characters is a comma-separated list of the existing character names on screen in that shot. Both are shot-level.",
  ),
  buildContext: (plan: ShotPlan) => ({
    characters: plan.characters.map(({ name, look }) => ({ name, look: clip(look, 200) })),
    locations: plan.locations.map(({ name, description }) => ({ name, description: clip(description, 200) })),
    scenes: plan.scenes.map((scene, sceneIndex) => ({
      scene: sceneIndex + 1,
      title: scene.title,
      shots: scene.shots.map((shot, shotIndex) => ({
        id: shotId(sceneIndex, shotIndex),
        location: shot.location,
        characters: shot.characters,
        speakers: [...new Set(shot.dialogue.map(({ speaker }) => speaker))],
        action: clip(shot.action),
      })),
    })),
  }),
};
