import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import { clip, type SpecialistDefinition, shotId, specialistInstructions } from "./shared";

const fields = ["framing", "camera"] as const;

export const cinematographyDirector: SpecialistDefinition = {
  id: "cinematography-director",
  role: "Director of Photography",
  fields,
  schema: specialistOutput(fields),
  maxOutputTokens: 1_500,
  instructions: specialistInstructions(
    "Director of Photography",
    "You are a professional cinematographer. Judge shot size, angle, composition, lens, camera movement, lighting and visual motifs by how well they express each shot's emotion and the film's intent, and keep coverage achievable on a short-film shoot.",
    "Fields: framing is the shot size, angle and composition (e.g. \"Close-up, low angle, subject on the left third\"); camera is movement, lens and lighting (e.g. \"Slow push-in, 85mm, warm practical key\"). Both are shot-level.",
  ),
  buildContext: (plan: ShotPlan) => ({
    title: plan.title,
    intent: plan.intent,
    locations: plan.locations.map(({ name, description }) => ({ name, description: clip(description, 240) })),
    scenes: plan.scenes.map((scene, sceneIndex) => ({
      scene: sceneIndex + 1,
      title: scene.title,
      shots: scene.shots.map((shot, shotIndex) => ({
        id: shotId(sceneIndex, shotIndex),
        framing: shot.framing,
        camera: shot.camera,
        location: shot.location,
        characters: shot.characters,
        action: clip(shot.action),
        emotion: clip(shot.emotion, 200),
      })),
    })),
  }),
};
