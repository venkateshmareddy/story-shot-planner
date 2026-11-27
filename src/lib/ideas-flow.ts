// Story-suggestion explorer: pure, client-safe state helpers.
import {
  type ConceptDigest,
  conceptDigest,
  conceptSource,
  MAX_AVOID,
  MAX_COMBINE,
  seedContextFromConcept,
  type StoryConcept,
} from "./ideas";
import type { StorySession } from "./session";
import { toCollected } from "./story-context";
import type { UsageRecord } from "./usage";

// Mirrors the request limits in src/lib/server/ideas.ts (server-only) until they move into the shared contract.
export const IDEA_INPUT_LIMITS = { direction: 300, question: 500, answer: 1_000, change: 1_000, note: 500 } as const;

/** Where a response's concept goes: in place of an existing card, or after the last one. */
export type ConceptPlacement = { kind: "replace"; id: string } | { kind: "append" };

/** Seeds a freshly created project from the chosen concept. Every seeded fact stays an unapproved AI suggestion. */
export function sessionFromConcept(session: StorySession, concept: StoryConcept, usage: UsageRecord[]): StorySession {
  const context = seedContextFromConcept(concept, session.context);
  return {
    ...session,
    source: conceptSource(concept),
    context,
    collected: toCollected(context),
    usage: [...session.usage, ...usage],
  };
}

/** Replace puts the first incoming concept where the target card was (or appends if it is gone); append adds all. */
export function placeConcepts(
  list: StoryConcept[],
  incoming: StoryConcept[],
  placement: ConceptPlacement,
): StoryConcept[] {
  if (incoming.length === 0) return list;
  if (placement.kind === "replace") {
    const index = list.findIndex((concept) => concept.id === placement.id);
    if (index >= 0) return [...list.slice(0, index), incoming[0], ...list.slice(index + 1)];
    return [...list, incoming[0]];
  }
  return [...list, ...incoming];
}

/** Every concept ever shown (dismissed and replaced ones included), newest kept when over MAX_AVOID. */
export function rememberShown(avoid: ConceptDigest[], concepts: StoryConcept[]): ConceptDigest[] {
  const next = [...avoid];
  for (const concept of concepts) {
    const digest = conceptDigest(concept);
    if (!next.some((item) => item.title === digest.title && item.premise === digest.premise)) next.push(digest);
  }
  return next.slice(-MAX_AVOID);
}

export function toggleSelected(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  return selected.length < MAX_COMBINE ? [...selected, id] : selected;
}

export function canCombine(count: number): boolean {
  return count >= 2 && count <= MAX_COMBINE;
}

/** The opening answer as one direction: the chosen chip, the typed text, or both. */
export function ideaDirection(chip: string | null, text: string): string {
  const typed = text.trim();
  if (chip && typed) return `${chip}: ${typed}`;
  return chip ?? typed;
}
