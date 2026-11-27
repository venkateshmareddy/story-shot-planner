import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import {
  clip,
  SPECIALIST_MAX_OUTPUT_TOKENS,
  type SpecialistDefinition,
  shotId,
  specialistInstructions,
} from "./shared";
import type { ImageReference } from "./types";

export const MAX_CONTEXT_REFERENCES = 4;

function referenceContext(references: readonly ImageReference[] | undefined) {
  return (references ?? []).slice(0, MAX_CONTEXT_REFERENCES).map((reference) => ({
    name: clip(reference.name, 80),
    summary: clip(reference.summary, 240),
    composition: clip(reference.composition, 200),
    lighting: clip(reference.lighting, 200),
    cameraAngle: clip(reference.cameraAngle, 160),
    colour: clip(reference.colour, 160),
    mood: clip(reference.mood, 160),
    shotIdeas: clip(reference.shotIdeas, 300),
  }));
}

const fields = ["framing", "camera"] as const;

export const cinematographyDirector: SpecialistDefinition = {
  id: "cinematography-director",
  role: "Director of Photography",
  fields,
  contextCategories: ["visuals", "lighting", "locations", "references", "genre", "intent", "format"],
  schema: specialistOutput(fields),
  maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
  instructions: specialistInstructions(
    "Director of Photography",
    "You think like a professional cinematographer: judge every visual choice by how well it expresses the shot's emotion and the film's intent, and keep coverage achievable on a short-film shoot. When plan.references is present, it describes the filmmaker's reference images: draw on their composition, lighting, angle, colour and mood where they suit the story, and name the reference you draw on.",
    'Fields: framing is the shot size, angle and composition (e.g. "Close-up, low angle, subject on the left third"); camera is movement, lens and lighting (e.g. "Slow push-in, 85mm, warm practical key"). Both are shot-level.',
    {
      id: "cinematography-director",
      checklist:
        "shot size and framing; camera angle and movement; lens and focal length; camera-to-subject distance; depth of field; composition and visual hierarchy (what the eye sees first); lighting direction and quality; colour and atmosphere; the emotional or story reason for each choice; the filmmaker's reference images when present",
    },
  ),
  buildContext: (plan: ShotPlan, references?: readonly ImageReference[]) => {
    const visualReferences = referenceContext(references);
    return {
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
      ...(visualReferences.length ? { references: visualReferences } : {}),
    };
  },
};
