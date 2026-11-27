import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import { clip, type SpecialistDefinition, shotId, specialistInstructions } from "./shared";

const fields = ["location", "characters"] as const;

export const continuityReviewer: SpecialistDefinition = {
  id: "continuity-reviewer",
  role: "Script Supervisor",
  fields,
  contextCategories: ["characters", "relationships", "locations", "scenes", "shots", "production"],
  schema: specialistOutput(fields),
  maxOutputTokens: 1_800,
  instructions: specialistInstructions(
    "Script Supervisor",
    "You think like a professional script supervisor: find the errors an audience would notice or a shoot would trip over, such as characters who speak or act without being listed in the shot, inconsistent names, and screen-geography problems.",
    "Fields: location is one location name, using an existing name exactly where one fits; characters is a comma-separated list of the existing character names on screen in that shot. Both are shot-level.",
    {
      id: "continuity-reviewer",
      checklist:
        "character appearance (costume, hair, makeup) and positioning in frame; props; locations; timeline and time of day; scene-to-scene consistency; visual and story errors",
    },
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
