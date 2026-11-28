import type { z } from "zod";
import { brainSections, loadBrain } from "@/lib/server/brain";
import { factStatus, type MemoryFact } from "@/lib/server/memory-view";
import {
  ANALYSIS_STYLE,
  DIRECTOR_PERSONA,
  MEMORY_RULE,
  PLAIN_LANGUAGE,
  SOURCE_RULES,
  SOURCE_STORY_RULE,
} from "@/lib/server/prompts";
import type { StoryCategoryId, StoryContext } from "@/lib/story-context";
import type { ShotPlan } from "@/lib/story-planning";
import { domainScore } from "./router";
import type { EditField } from "./schemas";
import { type DecisionRecord, type ImageReference, SPECIALIST_IDS, SPECIALIST_LABELS, type SpecialistId } from "./types";

export type SpecialistDefinition = {
  id: SpecialistId;
  role: string;
  instructions: string;
  /** Plan fields this specialist may propose edits for. */
  fields: readonly EditField[];
  /** StoryContext categories this specialist receives, most relevant first. */
  contextCategories: readonly StoryCategoryId[];
  /** Structured-output schema sent to the model. */
  schema: z.ZodType;
  maxOutputTokens: number;
  /** Only the plan slice this specialist needs. */
  buildContext: (plan: ShotPlan, references?: readonly ImageReference[]) => unknown;
  /** Receives the filmmaker's imported story (source) when the request has one. */
  readsSource?: boolean;
};

export const MAX_SPECIALIST_RECOMMENDATIONS = 5;
export const MAX_SPECIALIST_EDITS = 10;
// Room for 5 recommendations and 10 edits on a 60+ shot plan; ~70 s at the observed ~40 tokens/s.
export const SPECIALIST_MAX_OUTPUT_TOKENS = 2_800;
export const MAX_SPECIALIST_FACTS = 16;
export const MAX_SPECIALIST_OPEN_QUESTIONS = 4;
export const MAX_SPECIALIST_DECISIONS = 6;

export function shotId(sceneIndex: number, shotIndex: number) {
  const pad = (value: number) => String(value + 1).padStart(2, "0");
  return `S${pad(sceneIndex)}_SH${pad(shotIndex)}`;
}

export function clip(text: string, max = 400) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Bounds for plan text a specialist reads only as context, not as a field it edits. */
export const CONTEXT_ACTION_CHARACTERS = 300;
export const CONTEXT_EMOTION_CHARACTERS = 120;

type PlanScene = ShotPlan["scenes"][number];
export type PlanShot = PlanScene["shots"][number];
type ExcerptFields = Record<string, unknown>;

const SCENE_KEYS = new Set(["scene", "title", "shots"]);

const isBlank = (value: unknown) =>
  value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

function withoutBlanks(fields: ExcerptFields): ExcerptFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => !isBlank(value)));
}

function sharedFields(shots: readonly ExcerptFields[]): ExcerptFields {
  if (shots.length < 2) return {};
  const [first, ...rest] = shots;
  return Object.fromEntries(
    Object.entries(first).filter(([key, value]) => {
      const json = JSON.stringify(value);
      return !SCENE_KEYS.has(key) && rest.every((shot) => key in shot && JSON.stringify(shot[key]) === json);
    }),
  );
}

/**
 * The plan's scenes for one specialist: every scene and shot in plan order, each shot with its id, so an edit's 1-based
 * scene and shot numbers address the same shot in the full plan. `own` holds the fields the specialist may edit and is
 * sent for every shot as is; blank `context` values are dropped, and a context value every shot of a scene shares is
 * stated once on the scene.
 */
export function planExcerpt(
  plan: ShotPlan,
  own: (shot: PlanShot) => ExcerptFields,
  context: (shot: PlanShot) => ExcerptFields = () => ({}),
  sceneFields: (scene: PlanScene) => ExcerptFields = () => ({}),
) {
  return plan.scenes.map((scene, sceneIndex) => {
    const contexts = scene.shots.map((shot) => withoutBlanks(context(shot)));
    const shared = sharedFields(contexts);
    return {
      scene: sceneIndex + 1,
      title: scene.title,
      ...sceneFields(scene),
      ...shared,
      shots: scene.shots.map((shot, shotIndex) => ({
        id: shotId(sceneIndex, shotIndex),
        ...own(shot),
        ...Object.fromEntries(Object.entries(contexts[shotIndex]).filter(([key]) => !(key in shared))),
      })),
    };
  });
}

export { type FactStatus, factStatus } from "@/lib/server/memory-view";

export type SpecialistFact = MemoryFact;

export type SpecialistStoryContext = { facts: SpecialistFact[]; openQuestions: string[] };

/** The facts and open questions relevant to one discipline: constraints first, then by category relevance. */
export function specialistContext(
  context: StoryContext,
  id: SpecialistId,
  categories: readonly StoryCategoryId[],
): SpecialistStoryContext {
  const relevance = new Map(categories.map((category, index) => [category, index]));
  const facts = context.facts
    .filter((fact) => relevance.has(fact.category))
    .map((fact, index) => ({ fact, index, status: factStatus(fact), rank: relevance.get(fact.category) ?? 0 }))
    .sort(
      (a, b) =>
        Number(a.status === "ai_suggestion") - Number(b.status === "ai_suggestion") ||
        a.rank - b.rank ||
        a.index - b.index,
    )
    .slice(0, MAX_SPECIALIST_FACTS)
    .map(({ fact, status }) => ({
      category: fact.category,
      label: clip(fact.label, 80),
      value: clip(fact.value, 300),
      status,
    }));
  const openQuestions = context.unresolved
    .map((question, index) => ({ question, index, score: domainScore(question, id) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SPECIALIST_OPEN_QUESTIONS)
    .map(({ question }) => clip(question, 200));
  return { facts, openQuestions };
}

/** The filmmaker's latest decisions on earlier proposals, newest last. */
export function recentDecisions(decisions: readonly DecisionRecord[] | undefined) {
  return (decisions ?? []).slice(-MAX_SPECIALIST_DECISIONS).map(({ status, request, changes }) => ({
    status,
    request: clip(request, 240),
    changes: changes.slice(0, 5).map((change) => clip(change, 160)),
  }));
}

type ExpertBrain = Readonly<Record<"role" | "scope" | "expertise" | "checklist" | "fields", string>>;

const EXPERTS = Object.fromEntries(
  SPECIALIST_IDS.map((id) => [id, brainSections(`experts/${id}.md`, { SOURCE_STORY_RULE }) as ExpertBrain]),
) as Readonly<Record<SpecialistId, ExpertBrain>>;

const TEAM = loadBrain("experts/TEAM.md");

export type SpecialistDiscipline = {
  id: SpecialistId;
  /** Craft points to weigh where relevant. */
  checklist: string;
};

/** SAFETY, IDENTITY + SOUL, then experts/TEAM.md filled with the expert's own text, around the two writing styles. */
export function specialistInstructions(
  role: string,
  expertise: string,
  fieldRules: string,
  discipline?: SpecialistDiscipline,
) {
  const others = discipline
    ? SPECIALIST_IDS.filter((other) => other !== discipline.id)
        .map((other) => `${SPECIALIST_LABELS[other]} (${EXPERTS[other].scope})`)
        .join("; ")
    : "";
  const team = TEAM.sections({
    ROLE: role,
    EXPERTISE: expertise,
    CHECKLIST: discipline?.checklist ?? "",
    OTHERS: others,
    FIELD_RULES: fieldRules,
    MEMORY_RULE,
    MAX_SPECIALIST_RECOMMENDATIONS,
    MAX_SPECIALIST_EDITS,
  });
  return [
    SOURCE_RULES,
    DIRECTOR_PERSONA,
    team.intro,
    PLAIN_LANGUAGE,
    ANALYSIS_STYLE,
    discipline ? team.checklist : "",
    discipline ? `${team.stay} ${team.others}` : team.stay,
    team.rules,
  ]
    .filter(Boolean)
    .join("\n");
}

/** An expert's title from experts/<id>.md, such as "Story Analyst". */
export function specialistRole(id: SpecialistId): string {
  return EXPERTS[id].role;
}

/** One expert's full instructions, all from experts/<id>.md and experts/TEAM.md. */
export function expertInstructions(id: SpecialistId): string {
  const { role, expertise, fields, checklist } = EXPERTS[id];
  return specialistInstructions(role, expertise, fields, { id, checklist });
}
