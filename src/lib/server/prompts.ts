import { FILM_FORMATS, type FilmFormat } from "@/lib/formats";
import { MAX_COMBINE, MAX_CONCEPTS, MIN_CONCEPTS, SURPRISE_ME } from "@/lib/ideas";
import { MAX_OPTIONS } from "@/lib/interview";
import { MAX_FINDINGS, MAX_REFERENCES, MAX_TROPES, SEVERITIES, SEVERITY_DEFINITIONS } from "@/lib/originality";
import { brainFile, brainSections } from "@/lib/server/brain";
import { DECIDE_ANSWER, MAX_UNRESOLVED, SKIPPED_ANSWER } from "@/lib/story-context";
import { MAX_PLAN_SCENES, MAX_RENAMES } from "@/lib/story-planning";

export type Stage =
  | "draft"
  | "interview"
  | "plan_outline"
  | "plan_scene"
  | "edit_plan"
  | "edit_scene"
  | "ideas"
  | "originality_review"
  | "originality_compare";

export const STAGES: readonly Stage[] = [
  "draft",
  "interview",
  "plan_outline",
  "plan_scene",
  "edit_plan",
  "edit_scene",
  "ideas",
  "originality_review",
  "originality_compare",
];

export const SOURCE_RULES = brainFile("SAFETY.md");

/** The one authoritative runtime identity: IDENTITY.md + SOUL.md. Every story stage, specialist and the synthesis inherit it. */
export const DIRECTOR_PERSONA = `${brainFile("IDENTITY.md")} ${brainFile("SOUL.md")}`;

export const PLAIN_LANGUAGE = brainFile("style/PLAIN_WORDS.md");

/** Discovery: one short question with tappable answer choices. */
export const DISCOVERY_STYLE = brainFile("style/DISCOVERY.md", { MAX_OPTIONS });

/** Analysis: a plain one-line answer, then short grouped points, as detailed as the request needs. */
export const ANALYSIS_STYLE = brainFile("style/ANALYSIS.md");

/** A chosen AI story concept reaches interview and plan under SUGGESTED_CONCEPT_MARKER; it stays an AI suggestion. */
export const SUGGESTED_CONCEPT_RULE = brainFile("rules/SUGGESTED_CONCEPT.md");

/** The filmmaker's imported story (or its digest) reaches refine and the Story and Consistency experts as source. */
export const SOURCE_STORY_RULE = brainFile("rules/SOURCE_STORY.md");

/** How the "MEMORY — what we know" input section (src/lib/server/memory-view.ts) is laid out. */
export const MEMORY_RULE = brainFile("rules/MEMORY.md");

const STAGE_VARS = {
  SUGGESTED_CONCEPT_RULE,
  MEMORY_RULE,
  SHOT_RULES: brainFile("rules/SHOTS.md"),
  EDIT_HISTORY: brainFile("rules/EDIT_HISTORY.md", { SOURCE_STORY_RULE }),
  EDIT_DATA: brainFile("rules/EDIT_DATA.md"),
  MAX_PLAN_SCENES,
  MAX_RENAMES,
  MAX_UNRESOLVED,
  SKIPPED_ANSWER,
  DECIDE_ANSWER,
  SURPRISE_ME,
  MIN_CONCEPTS,
  MAX_CONCEPTS,
  MAX_COMBINE,
  MAX_TROPES,
  MAX_FINDINGS,
  MAX_CANDIDATES: MAX_REFERENCES,
  SEVERITY_RULES: SEVERITIES.map((severity) => `${severity}: ${SEVERITY_DEFINITIONS[severity]}`).join(" "),
};

const STAGE_BASE = Object.fromEntries(
  STAGES.map((stage) => [stage, brainFile(`stages/${stage}.md`, STAGE_VARS)]),
) as Readonly<Record<Stage, string>>;

function formatNotes(format: FilmFormat): Readonly<Record<Stage, string>> {
  const sections = brainSections(`formats/${format}.md`);
  const missing = STAGES.filter((stage) => !sections[stage]);
  if (missing.length) throw new Error(`formats/${format}.md has no section for ${missing.join(", ")}`);
  return sections as Readonly<Record<Stage, string>>;
}

const FORMAT_PROMPTS = Object.fromEntries(FILM_FORMATS.map((format) => [format, formatNotes(format)])) as Readonly<
  Record<FilmFormat, Readonly<Record<Stage, string>>>
>;

// Ideas, plan_scene and edit_scene return data (concepts, shots), not a reply to the filmmaker; neither conversation style fits.
const STAGE_STYLE: Record<Stage, string> = {
  draft: ANALYSIS_STYLE,
  interview: DISCOVERY_STYLE,
  plan_outline: ANALYSIS_STYLE,
  plan_scene: "",
  edit_plan: ANALYSIS_STYLE,
  edit_scene: "",
  ideas: "",
  originality_review: ANALYSIS_STYLE,
  originality_compare: ANALYSIS_STYLE,
};

export function composeInstructions(step: Stage, format: FilmFormat): string {
  return [SOURCE_RULES, DIRECTOR_PERSONA, PLAIN_LANGUAGE, STAGE_STYLE[step], STAGE_BASE[step], FORMAT_PROMPTS[format][step]]
    .filter(Boolean)
    .join("\n");
}
