import type { ShotPlan } from "@/lib/story-planning";
import { specialistOutput } from "./schemas";
import {
  expertInstructions,
  CONTEXT_ACTION_CHARACTERS,
  clip,
  planExcerpt,
  SPECIALIST_MAX_OUTPUT_TOKENS,
  type SpecialistDefinition,
  specialistRole,
} from "./shared";

const fields = ["location", "characters"] as const;

export const continuityReviewer: SpecialistDefinition = {
  id: "continuity-reviewer",
  role: specialistRole("continuity-reviewer"),
  fields,
  contextCategories: ["characters", "relationships", "locations", "scenes", "shots", "production"],
  schema: specialistOutput(fields),
  maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
  readsSource: true,
  instructions: expertInstructions("continuity-reviewer"),
  buildContext: (plan: ShotPlan) => ({
    characters: plan.characters.map(({ name, look }) => ({ name, look: clip(look, 200) })),
    locations: plan.locations.map(({ name, description }) => ({ name, description: clip(description, 200) })),
    scenes: planExcerpt(
      plan,
      ({ location, characters }) => ({ location, characters }),
      (shot) => ({
        unlistedSpeakers: [...new Set(shot.dialogue.map(({ speaker }) => speaker))].filter(
          (speaker) => !shot.characters.includes(speaker),
        ),
        action: clip(shot.action, CONTEXT_ACTION_CHARACTERS),
      }),
    ),
  }),
};
