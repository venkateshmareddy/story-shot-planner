// AI story suggestions — shared types and pure helpers. Client-safe: no OpenAI or server code.
import { MAX_SESSION_TITLE } from "./session";
import type { StorySource } from "./source-text";
import { type ContextFact, EMPTY_CONTEXT, mergeFacts, type StoryContext } from "./story-context";
import type { UsageRecord } from "./usage";

export type StoryConcept = {
  id: string;
  title: string;
  genre: string;
  premise: string;
  mainCharacter: string;
  conflict: string;
  emotionalHook: string;
  plotDirection: string;
  /** Why the idea works on screen. */
  cinematicAppeal: string;
};

/** A short fingerprint of a concept already shown, so the AI avoids repeating it. */
export type ConceptDigest = { title: string; premise: string };

export type IdeaExchange = { question: string; answer: string };

export const SURPRISE_ME = "Surprise me";
export const MIN_CONCEPTS = 3;
export const MAX_CONCEPTS = 5;
/** At most this many AI follow-up questions before concepts are generated. */
export const MAX_IDEA_QUESTIONS = 2;
export const MAX_AVOID = 20;
export const MAX_COMBINE = 3;

/** Optional starting directions shown with the opening question. */
export const IDEA_DIRECTIONS = [
  "A genre I love",
  "A theme or feeling",
  "Something from real life",
  "A character-driven story",
  "A mystery or strange situation",
  "Something completely unexpected",
] as const;

/** POST /api/story/ideas request body. One model call per request. */
export type IdeasRequest =
  /** First concepts (or one short follow-up question while the direction is still vague). */
  | { mode: "generate"; direction: string; answers: IdeaExchange[]; avoid: ConceptDigest[] }
  /** One genuinely different concept, avoiding everything already shown. */
  | { mode: "another"; direction: string; answers: IdeaExchange[]; avoid: ConceptDigest[] }
  /** One reworked version of a concept, applying the filmmaker's change. */
  | { mode: "refine"; concept: StoryConcept; change: string }
  /** One new concept combining 2–3 selected concepts. */
  | { mode: "combine"; concepts: StoryConcept[]; note: string };

/** POST /api/story/ideas success response. Exactly one of `question` / `concepts` is meaningful. */
export type IdeasResponse = {
  /** A single short follow-up question (generate mode only), or null when concepts are returned. */
  question: { text: string; options: string[] } | null;
  concepts: StoryConcept[];
  usage: UsageRecord;
};

export function conceptDigest(concept: StoryConcept): ConceptDigest {
  return { title: concept.title, premise: concept.premise };
}

export function conceptProjectTitle(concept: StoryConcept): string {
  const title = concept.title.replace(/\s+/g, " ").trim();
  return (title || "Untitled idea").slice(0, MAX_SESSION_TITLE);
}

/** The concept as readable text: the project's starting source (an AI suggestion, never the filmmaker's). */
export function conceptText(concept: StoryConcept): string {
  return [
    `Title: ${concept.title}`,
    `Genre: ${concept.genre}`,
    `Premise: ${concept.premise}`,
    `Main character: ${concept.mainCharacter}`,
    `Central conflict: ${concept.conflict}`,
    `Emotional hook: ${concept.emotionalHook}`,
    `Possible plot direction: ${concept.plotDirection}`,
    `Why it works on screen: ${concept.cinematicAppeal}`,
  ].join("\n");
}

export function conceptSource(concept: StoryConcept): StorySource {
  const text = conceptText(concept);
  return { name: conceptProjectTitle(concept), kind: "suggestion", characters: text.length, text };
}

/** Seed facts from a chosen concept. All are AI suggestions (unapproved) until the filmmaker approves them. */
export function conceptFacts(concept: StoryConcept): ContextFact[] {
  const fact = (category: ContextFact["category"], label: string, value: string): ContextFact => ({
    category,
    label,
    value,
    source: "ai",
    approved: false,
  });
  return [
    fact("concept", "Premise", concept.premise),
    fact("concept", "Central conflict", concept.conflict),
    fact("genre", "Genre", concept.genre),
    fact("characters", "Main character", concept.mainCharacter),
    fact("intent", "Emotional hook", concept.emotionalHook),
    fact("structure", "Possible plot direction", concept.plotDirection),
    fact("visuals", "Why it works on screen", concept.cinematicAppeal),
  ].filter((item) => item.value.trim());
}

export function seedContextFromConcept(concept: StoryConcept, base: StoryContext = EMPTY_CONTEXT): StoryContext {
  return mergeFacts(base, conceptFacts(concept));
}
