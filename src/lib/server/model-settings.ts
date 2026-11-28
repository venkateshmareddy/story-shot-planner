import type { UsageStep } from "@/lib/usage";

export type ModelVerbosity = "low" | "medium";

export type StageSettings = { readonly verbosity: ModelVerbosity };

/**
 * Request settings per model stage, applied by every call path. "low" where the output is structured data or a
 * short turn (live: interview output −24%, Camera expert −13%, same quality); "medium" where the filmmaker reads
 * the prose.
 * Reasoning effort is left unset: these calls already report 0 reasoning tokens.
 */
export const MODEL_SETTINGS = {
  interview: { verbosity: "low" },
  plan_scene: { verbosity: "low" },
  edit_scene: { verbosity: "low" },
  "story-analyst": { verbosity: "low" },
  "cinematography-director": { verbosity: "low" },
  "sound-director": { verbosity: "low" },
  "editing-director": { verbosity: "low" },
  "continuity-reviewer": { verbosity: "low" },
  ideas: { verbosity: "low" },
  digest: { verbosity: "low" },
  originality_review: { verbosity: "low" },
  originality_compare: { verbosity: "low" },
  draft: { verbosity: "medium" },
  plan_outline: { verbosity: "medium" },
  edit_plan: { verbosity: "medium" },
  synthesis: { verbosity: "medium" },
  "image-analysis": { verbosity: "medium" },
} as const satisfies Record<string, StageSettings>;

export type ModelStage = keyof typeof MODEL_SETTINGS;

/** The stage a call runs as when it doesn't name one; null: the step spans stages, or makes no Responses call. */
const STAGE_BY_STEP: Record<UsageStep, ModelStage | null> = {
  draft: "draft",
  interview: "interview",
  plan: null,
  refine: null,
  transcribe: null,
  orchestrator: "synthesis",
  "story-analyst": "story-analyst",
  "cinematography-director": "cinematography-director",
  "sound-director": "sound-director",
  "editing-director": "editing-director",
  "continuity-reviewer": "continuity-reviewer",
  "image-analysis": "image-analysis",
  digest: "digest",
  ideas: "ideas",
  originality: null,
  "originality-lookup": null,
};

export function stageSettings(stage: ModelStage | null): StageSettings | null {
  return stage ? MODEL_SETTINGS[stage] : null;
}

export function stageForStep(step: UsageStep): ModelStage | null {
  return STAGE_BY_STEP[step];
}
