// StoryContext — the shared project state from the 20-category framework.
// Categories 1–18 are the creative/production data below; category 19 (question management)
// is the discovery controller and category 20 is this model. Pure TS, client-safe, no zod.

export type CategoryPriority = "critical" | "high" | "medium" | "optional";

export const STORY_CATEGORIES = [
  { id: "concept", number: 1, label: "Story idea", priority: "critical" },
  { id: "genre", number: 2, label: "Genre and tone", priority: "critical" },
  { id: "format", number: 3, label: "Length and format", priority: "critical" },
  { id: "audience", number: 4, label: "Audience", priority: "high" },
  { id: "characters", number: 5, label: "Characters", priority: "high" },
  { id: "relationships", number: 6, label: "Relationships", priority: "medium" },
  { id: "locations", number: 7, label: "Places and setting", priority: "medium" },
  { id: "structure", number: 8, label: "Story shape and ending", priority: "high" },
  { id: "intent", number: 9, label: "Feeling and message", priority: "high" },
  { id: "visuals", number: 10, label: "Camera style", priority: "medium" },
  { id: "lighting", number: 11, label: "Light and colour", priority: "optional" },
  { id: "dialogue", number: 12, label: "Dialogue and language", priority: "medium" },
  { id: "sound", number: 13, label: "Sound and music", priority: "optional" },
  { id: "scenes", number: 14, label: "Scene plan", priority: "medium" },
  { id: "shots", number: 15, label: "Shot plan", priority: "optional" },
  { id: "production", number: 16, label: "Practical limits", priority: "optional" },
  { id: "references", number: 17, label: "References and inspiration", priority: "optional" },
  { id: "delivery", number: 18, label: "Final output", priority: "optional" },
] as const satisfies readonly { id: string; number: number; label: string; priority: CategoryPriority }[];

export type StoryCategoryId = (typeof STORY_CATEGORIES)[number]["id"];
export type StoryCategory = (typeof STORY_CATEGORIES)[number];

export const PRIORITY_ORDER: Record<CategoryPriority, number> = { critical: 0, high: 1, medium: 2, optional: 3 };

export type FactSource = "user" | "ai";

export type ContextFact = {
  category: StoryCategoryId;
  /** Short plain-language label, e.g. "Main character". */
  label: string;
  value: string;
  /** "user" = the filmmaker said it; "ai" = inferred or suggested by the AI. */
  source: FactSource;
  /** User facts are approved; AI facts stay unapproved until the filmmaker approves them. */
  approved: boolean;
  /** Index into `answered` of the answer this filmmaker fact was taken from; editing that answer retracts it. */
  answer?: number;
};

/** A fact the filmmaker removed; the same key and value is never re-added by the AI. */
export type RemovedFact = { key: string; value: string };

export type StoryContext = {
  facts: ContextFact[];
  /** Open questions or ambiguities the AI still sees. */
  unresolved: string[];
  removed?: RemovedFact[];
};

export const MAX_CONTEXT_FACTS = 80;
export const MAX_UNRESOLVED = 8;
export const MAX_REMOVED_FACTS = 40;
export const MAX_FACT_VALUE = 600;
export const EMPTY_CONTEXT: StoryContext = { facts: [], unresolved: [] };

export function categoryOf(id: StoryCategoryId): StoryCategory {
  return STORY_CATEGORIES.find((category) => category.id === id) ?? STORY_CATEGORIES[0];
}

export function factKey(fact: Pick<ContextFact, "category" | "label">): string {
  return `${fact.category}:${fact.label.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function sameFactValue(a: string, b: string): boolean {
  const normal = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  return normal(a) === normal(b);
}

function isRemoved(context: StoryContext, fact: ContextFact): boolean {
  const key = factKey(fact);
  return (context.removed ?? []).some((item) => item.key === key && sameFactValue(item.value, fact.value));
}

function withRemoved(context: StoryContext): Pick<StoryContext, "removed"> {
  return context.removed?.length ? { removed: context.removed.slice(-MAX_REMOVED_FACTS) } : {};
}

/**
 * Merge fact updates into a context. Same category+label replaces the old fact, except an AI
 * update never overwrites a filmmaker-provided or approved fact (approved decisions are preserved).
 * Never mutates the input.
 */
export function mergeFacts(context: StoryContext, updates: ContextFact[]): StoryContext {
  const facts = context.facts.map((fact) => ({ ...fact }));
  for (const update of updates) {
    const value = update.value.trim();
    const label = update.label.trim();
    if (!value || !label) continue;
    const next: ContextFact = { ...update, label, value, approved: update.source === "user" ? true : update.approved };
    if (isRemoved(context, next)) continue;
    const index = facts.findIndex((fact) => factKey(fact) === factKey(next));
    if (index === -1) {
      facts.push(next);
    } else {
      const current = facts[index];
      const protectedFact = current.source === "user" || current.approved;
      if (next.source === "ai" && protectedFact) continue;
      facts[index] = next;
    }
  }
  while (facts.length > MAX_CONTEXT_FACTS) {
    const dropIndex = facts.findIndex((fact) => fact.source === "ai" && !fact.approved);
    facts.splice(dropIndex === -1 ? 0 : dropIndex, 1);
  }
  return { facts, unresolved: context.unresolved.slice(0, MAX_UNRESOLVED), ...withRemoved(context) };
}

export function withUnresolved(context: StoryContext, unresolved: string[]): StoryContext {
  const clean = [...new Set(unresolved.map((item) => item.trim()).filter(Boolean))].slice(0, MAX_UNRESOLVED);
  return { facts: context.facts, unresolved: clean, ...withRemoved(context) };
}

export function approveFact(context: StoryContext, key: string): StoryContext {
  return { ...context, facts: context.facts.map((fact) => (factKey(fact) === key ? { ...fact, approved: true } : fact)) };
}

/** Remove a fact and remember it, so the AI doesn't add the same detail back. */
export function removeFact(context: StoryContext, key: string): StoryContext {
  const target = context.facts.find((fact) => factKey(fact) === key);
  if (!target) return context;
  const removed = [...(context.removed ?? []).filter((item) => item.key !== key), { key, value: target.value }];
  return {
    ...context,
    facts: context.facts.filter((fact) => factKey(fact) !== key),
    removed: removed.slice(-MAX_REMOVED_FACTS),
  };
}

/** The filmmaker rewrote a fact: it becomes their approved decision, no longer tied to an answer. Empty text is ignored. */
export function editFact(context: StoryContext, key: string, value: string): StoryContext {
  const text = value.trim().slice(0, MAX_FACT_VALUE);
  if (!text) return context;
  return {
    ...context,
    facts: context.facts.map((fact) => {
      if (factKey(fact) !== key) return fact;
      const { answer: _answer, ...rest } = fact;
      return { ...rest, value: text, source: "user", approved: true };
    }),
  };
}

/** An earlier answer was edited: drop the filmmaker facts taken from it so the next turn re-reads the new wording. */
export function retractAnswerFacts(context: StoryContext, answerIndex: number): StoryContext {
  return {
    ...context,
    facts: context.facts.filter((fact) => !(fact.source === "user" && fact.answer === answerIndex)),
  };
}

/** Categories with no facts yet, most important first. */
export function missingCategories(context: StoryContext): StoryCategory[] {
  const covered = new Set(context.facts.map((fact) => fact.category));
  return STORY_CATEGORIES.filter((category) => !covered.has(category.id)).sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.number - b.number,
  );
}

export type Readiness = {
  critical: { covered: number; total: number };
  high: { covered: number; total: number };
  /** Enough for a coherent first draft: every critical category is covered. */
  ready: boolean;
};

export function contextReadiness(context: StoryContext): Readiness {
  const covered = new Set(context.facts.map((fact) => fact.category));
  const count = (priority: CategoryPriority) => {
    const list = STORY_CATEGORIES.filter((category) => category.priority === priority);
    return { covered: list.filter((category) => covered.has(category.id)).length, total: list.length };
  };
  const critical = count("critical");
  return { critical, high: count("high"), ready: critical.covered === critical.total };
}

/** Flatten the context for prompts and legacy views: filmmaker/approved facts first, then by priority. */
export function toCollected(context: StoryContext, max = 40): { label: string; detail: string }[] {
  return [...context.facts]
    .sort(
      (a, b) =>
        Number(b.source === "user" || b.approved) - Number(a.source === "user" || a.approved) ||
        PRIORITY_ORDER[categoryOf(a.category).priority] - PRIORITY_ORDER[categoryOf(b.category).priority],
    )
    .slice(0, max)
    .map((fact) => ({
      label: `${categoryOf(fact.category).label}: ${fact.label}`,
      detail: fact.source === "ai" && !fact.approved ? `${fact.value} (AI suggestion)` : fact.value,
    }));
}

export type DiscoveryCommand = "stop" | "skip" | "decide";

const STOP = /^(?:please )?(?:stop(?: (?:here|asking(?: (?:questions?|now))?(?: and (?:generate|create|make|build)(?: the| my)?(?: shot)? plan(?: now)?)?|the (?:questions?|interview)))?|proceed(?: with)?(?: (?:the|my))? (?:shot )?plan(?:ning)?|go ahead(?: with)?(?: (?:the|my))? (?:shot )?plan(?:ning)?|proceed|go ahead|done|enough|that'?s enough|let'?s go|start planning|(generate|create|make|build)( the| my)?( shot)? plan( now)?)$/;
const SKIP = /^(skip|skip (this|it|this one)|next|pass|next question)$/;
const DECIDE = /^(you decide|your call|up to you|you choose|decide for me|surprise me|i don'?t know|no idea|any)$/;

/** Detect a whole-message discovery command. A sentence that merely contains "stop" is not a command. */
export function detectDiscoveryCommand(text: string): DiscoveryCommand | null {
  const normal = text.toLowerCase().replace(/[.!?,"']+$/g, "").replace(/^[\s"']+|[\s"']+$/g, "").replace(/\s+/g, " ");
  if (STOP.test(normal)) return "stop";
  if (SKIP.test(normal)) return "skip";
  if (DECIDE.test(normal)) return "decide";
  return null;
}

/** The answer text recorded for skip/decide so the model never asks the same thing again. */
export const SKIPPED_ANSWER = "(Skipped — fill this in later or let the AI suggest something.)";
export const DECIDE_ANSWER = "(You decide — make a sensible choice and mark it as an AI suggestion.)";
