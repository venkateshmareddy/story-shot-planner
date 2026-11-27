import type { z } from "zod";
import { ANALYSIS_STYLE, DIRECTOR_PERSONA, PLAIN_LANGUAGE, SOURCE_RULES } from "@/lib/server/prompts";
import type { ContextFact, StoryCategoryId, StoryContext } from "@/lib/story-context";
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

export type FactStatus = "filmmaker" | "approved" | "ai_suggestion";

export type SpecialistFact = { category: StoryCategoryId; label: string; value: string; status: FactStatus };

export type SpecialistStoryContext = { facts: SpecialistFact[]; openQuestions: string[] };

export function factStatus(fact: Pick<ContextFact, "source" | "approved">): FactStatus {
  if (fact.source === "user") return "filmmaker";
  return fact.approved ? "approved" : "ai_suggestion";
}

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

const DISCIPLINE_SCOPE: Record<SpecialistId, string> = {
  "story-analyst": "story purpose, motivation, conflict, structure and what the dialogue says",
  "cinematography-director": "framing, camera angle and movement, lens, lighting and colour",
  "sound-director": "dialogue clarity, ambience, effects, music and silence",
  "editing-director": "shot length, pacing, cuts, transitions and scene order",
  "continuity-reviewer": "names, appearance, props, places and timeline consistency",
};

export type SpecialistDiscipline = {
  id: SpecialistId;
  /** Craft points to weigh where relevant. */
  checklist: string;
};

export function specialistInstructions(
  role: string,
  expertise: string,
  fieldRules: string,
  discipline?: SpecialistDiscipline,
) {
  const others = discipline
    ? SPECIALIST_IDS.filter((other) => other !== discipline.id)
        .map((other) => `${SPECIALIST_LABELS[other]} (${DISCIPLINE_SCOPE[other]})`)
        .join("; ")
    : "";
  return [
    SOURCE_RULES,
    DIRECTOR_PERSONA,
    `In this call you work as the team's ${role}, bringing the Creative Director's judgement to one discipline. ${expertise}`,
    PLAIN_LANGUAGE,
    ANALYSIS_STYLE,
    discipline
      ? `Checklist (consider where relevant, never all at once; pick what this request and this plan actually need): ${discipline.checklist}.`
      : "",
    discipline
      ? `Stay strictly in your discipline. The other experts cover ${others}. Leave those points to them so the team never repeats itself.`
      : "Stay strictly in your discipline.",
    "Input: the filmmaker's message; recent conversation (recent); the project context relevant to you (context: facts with category, label, value and status, plus openQuestions still unresolved), or for older projects a flat list of approved details (approved); the filmmaker's decisions on earlier proposals, newest last (decisions); and the plan excerpt for your discipline (plan).",
    "Facts with status filmmaker or approved, and approved details, are constraints: build on them and never contradict them; if one hurts the film, say why and offer an alternative for the filmmaker to decide. Facts with status ai_suggestion are earlier AI guesses you may challenge or replace. Treat openQuestions as unknowns and mark anything you assume about them as an assumption. Build on accepted decisions. Never re-propose a change from a rejected decision unless the filmmaker's message asks for it again.",
    `summary: answer the filmmaker's message directly in 2-5 sentences with your main judgement and why; give a fuller assessment when they ask for a review. recommendations: up to ${MAX_SPECIALIST_RECOMMENDATIONS}, most important first, only points that matter. target is a shot id like S01_SH02, "Scene 2", "Character: Name" or "Overall"; issue names the specific problem in this plan; recommendation is the specific, actionable change (what, where and how); rationale explains why it matters for the audience or the shoot; priority is high (clearly hurts the film or the shoot), medium or low.`,
    `edits: concrete replacement values, only when the filmmaker asks for a change or a clear fix exists in your discipline; otherwise []. At most ${MAX_SPECIALIST_EDITS} edits, the ones with the most impact first, even when the filmmaker asks about every shot or scene; when many shots need the same kind of change, say it once as a recommendation instead of editing each shot. scene and shot are 1-based and match the ids (S02_SH03 is scene 2, shot 3). ${fieldRules} value is the complete new text for that field. Edit only your own fields. You recommend and propose; the filmmaker approves every edit.`,
    "Never invent story events, characters or dialogue.",
  ]
    .filter(Boolean)
    .join("\n");
}
