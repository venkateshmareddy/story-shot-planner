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
  role: specialistRole("cinematography-director"),
  fields,
  contextCategories: ["visuals", "lighting", "locations", "references", "genre", "intent", "format"],
  schema: specialistOutput(fields),
  maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
  instructions: expertInstructions("cinematography-director"),
  buildContext: (plan: ShotPlan, references?: readonly ImageReference[]) => {
    const visualReferences = referenceContext(references);
    return {
      title: plan.title,
      intent: plan.intent,
      locations: plan.locations.map(({ name, description }) => ({ name, description: clip(description, 240) })),
      scenes: planExcerpt(
        plan,
        ({ framing, camera }) => ({ framing, camera }),
        (shot) => ({
          location: shot.location,
          characters: shot.characters,
          action: clip(shot.action, CONTEXT_ACTION_CHARACTERS),
          emotion: clip(shot.emotion, CONTEXT_EMOTION_CHARACTERS),
        }),
      ),
      ...(visualReferences.length ? { references: visualReferences } : {}),
    };
  },
};
