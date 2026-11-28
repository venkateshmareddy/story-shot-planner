import type { FilmFormat } from "@/lib/formats";
import { type CollectedItem, EXTRA_DIRECTION_QUESTION, type InterviewExchange, visualGaps } from "@/lib/interview";
import {
  type ContextFact,
  EMPTY_CONTEXT,
  missingCategories,
  type RemovedFact,
  type StoryCategoryId,
  type StoryContext,
} from "@/lib/story-context";
import { visualHint } from "@/lib/visual-discovery";

/**
 * The project's memory as the model reads it: compact Markdown sections instead of JSON. Pure. Section titles are
 * named exactly in the brain's stage and expert files. Filmmaker free text is fenced; list items are one line each,
 * so no text can start a section of its own. Plan data stays minified JSON (edits need exact positions).
 */
export const SECTION = {
  format: "FORMAT",
  story: "STORY",
  answers: "ANSWERS",
  directions: "DIRECTIONS",
  memory: "MEMORY — what we know",
  removed: "REMOVED by the filmmaker",
  openQuestions: "OPEN QUESTIONS",
  missing: "MISSING",
  collected: "COLLECTED",
  plan: "PLAN (JSON)",
  sceneIndexes: "SCENE INDEXES",
  source: "STORY SOURCE",
  decisions: "DECISIONS",
  chat: "RECENT CHAT",
  hints: "HINTS",
  message: "MESSAGE",
  outline: "OUTLINE (JSON)",
  sceneToWrite: "SCENE TO WRITE",
  overview: "OVERVIEW (JSON)",
  renames: "RENAMES",
  scene: "SCENE (JSON)",
  newScene: "NEW SCENE",
  referenced: "REFERENCED SCENES (JSON)",
  neighbours: "NEIGHBOURS",
  instruction: "INSTRUCTION",
  established: "ESTABLISHED",
  findings: "FINDINGS",
  failed: "FAILED",
  mergeConflicts: "MERGE CONFLICTS",
  proposedChanges: "PROPOSED CHANGES",
  planText: "PLAN",
  dismissed: "DISMISSED",
  references: "REFERENCES",
  film: "FILM",
  scenes: "SCENES",
  sceneToAssess: "SCENE TO ASSESS",
  sceneAssessments: "SCENE ASSESSMENTS",
  visualGaps: "VISUAL GAPS",
} as const;

export type SectionTitle = (typeof SECTION)[keyof typeof SECTION];

/** Whitespace, line breaks included, collapsed to single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A fenced block longer than any backtick run inside, so the text can never close it early. */
export function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text.trim()}\n${fence}`;
}

/** "## title" and its lines; "" when there is nothing to say, so empty sections cost nothing. */
export function section(title: SectionTitle, body: string | readonly string[]): string {
  const text = (typeof body === "string" ? body : body.join("\n")).trim();
  return text ? `## ${title}\n${text}` : "";
}

/** One model input: the non-empty sections, stable ones first, in the order given. */
export function sections(...parts: readonly string[]): string {
  return parts.filter(Boolean).join("\n");
}

export function jsonSection(title: SectionTitle, value: unknown): string {
  return section(title, JSON.stringify(value));
}

export type FactStatus = "filmmaker" | "approved" | "ai_suggestion";

export type MemoryFact = { category: StoryCategoryId; label: string; value: string; status: FactStatus };

export function factStatus(fact: Pick<ContextFact, "source" | "approved">): FactStatus {
  if (fact.source === "user") return "filmmaker";
  return fact.approved ? "approved" : "ai_suggestion";
}

const GROUPS: readonly [FactStatus, string][] = [
  ["filmmaker", "From the filmmaker:"],
  ["approved", "Approved:"],
  ["ai_suggestion", "AI suggestions:"],
];

/** "- category · Label: value" grouped by who said it, each group in the order given. */
export function memorySection(facts: readonly MemoryFact[]): string {
  return section(
    SECTION.memory,
    GROUPS.flatMap(([status, heading]) => {
      const lines = facts
        .filter((fact) => fact.status === status)
        .map(({ category, label, value }) => `- ${category} · ${oneLine(label)}: ${oneLine(value)}`);
      return lines.length ? [heading, ...lines] : [];
    }),
  );
}

export function contextFacts(context: StoryContext): MemoryFact[] {
  return context.facts.map(({ category, label, value, source, approved }) => ({
    category,
    label,
    value,
    status: factStatus({ source, approved }),
  }));
}

/** Removed keys are "category:label"; shown like memory lines so the model can match what it must not re-add. */
export function removedSection(removed: readonly RemovedFact[] | undefined): string {
  return section(
    SECTION.removed,
    (removed ?? []).map(({ key, value }) => {
      const split = key.indexOf(":");
      const name = split === -1 ? oneLine(key) : `${key.slice(0, split)} · ${oneLine(key.slice(split + 1))}`;
      return `- ${name}: ${oneLine(value)}`;
    }),
  );
}

export function listSection(title: SectionTitle, items: readonly string[]): string {
  return section(
    title,
    items.map(oneLine).filter(Boolean).map((item) => `- ${item}`),
  );
}

/** Numbered Q/A pairs, oldest first. */
export function answersSection(answers: readonly InterviewExchange[]): string {
  return section(
    SECTION.answers,
    answers.flatMap(({ question, answer }, index) => [`Q${index + 1}: ${oneLine(question)}`, `A${index + 1}: ${oneLine(answer)}`]),
  );
}

/** Interview answers and the extra directions sent after discovery, apart. */
export function splitDirections(answers: readonly InterviewExchange[]) {
  return {
    answers: answers.filter(({ question }) => question !== EXTRA_DIRECTION_QUESTION),
    directions: answers.filter(({ question }) => question === EXTRA_DIRECTION_QUESTION).map(({ answer }) => answer),
  };
}

export function collectedSection(collected: readonly CollectedItem[]): string {
  return listSection(
    SECTION.collected,
    collected.map(({ label, detail }) => `${label}: ${detail}`),
  );
}

export type Decision = { status: "accepted" | "rejected"; request: string; changes: readonly string[] };

/** The filmmaker's verdicts on earlier proposals, oldest first. */
export function decisionsSection(decisions: readonly Decision[] | undefined): string {
  return section(
    SECTION.decisions,
    (decisions ?? []).map(({ status, request, changes }) => {
      const changed = changes.map(oneLine).filter(Boolean).join("; ");
      return `- ${status === "accepted" ? "Applied" : "Discarded"}: ${oneLine(request)}${changed ? ` → ${changed}` : ""}`;
    }),
  );
}

export type ChatLine = { role: "user" | "agent"; text: string };

export function chatSection(messages: readonly ChatLine[]): string {
  return section(
    SECTION.chat,
    messages.map(({ role, text }) => `${role === "user" ? "Filmmaker" : "Creative Director"}: ${oneLine(text)}`),
  );
}

export function textSection(title: SectionTitle, text: string | undefined): string {
  return text?.trim() ? section(title, fenced(text)) : "";
}

export type InterviewRequest = {
  story: string;
  answered?: readonly InterviewExchange[];
  context?: StoryContext;
  format?: FilmFormat;
};

const MAX_GAP_LINES = 4;

/** "- name: what to ask about" for the open key looks, then how many look questions are left; "" when none. */
export function visualGapsSection(context: StoryContext, answered: readonly InterviewExchange[]): string {
  const { left, gaps } = visualGaps(context, answered);
  if (!gaps.length) return "";
  return section(SECTION.visualGaps, [
    ...gaps.slice(0, MAX_GAP_LINES).map((entity) => `- ${oneLine(entity.name)}: ${visualHint(entity)}`),
    `Look questions left: ${left}`,
  ]);
}

/** One interview turn's input: everything said and known so far, then what is still missing. */
export function interviewInput({ story, answered = [], context = EMPTY_CONTEXT, format }: InterviewRequest): string {
  return sections(
    format ? section(SECTION.format, format) : "",
    textSection(SECTION.story, story),
    answersSection(answered),
    memorySection(contextFacts(context)),
    removedSection(context.removed),
    listSection(SECTION.openQuestions, context.unresolved),
    section(SECTION.missing, missingCategories(context).map(({ id }) => id).join(", ")),
    visualGapsSection(context, answered),
  );
}
