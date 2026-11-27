import { z } from "zod";
import {
  type ContextFact,
  detectDiscoveryCommand,
  mergeFacts,
  type StoryContext,
  toCollected,
  withUnresolved,
} from "./story-context";
import { storyCategorySchema } from "./story-context-schema";

export const MAX_INTERVIEW_TURNS = 12;

export const collectedItem = z.object({
  label: z.string(),
  detail: z.string(),
});
export type CollectedItem = z.infer<typeof collectedItem>;

// No length constraints here: strict structured outputs reject them; values are clipped in resolveInterviewTurn.
export const interviewFact = z.object({
  category: storyCategorySchema,
  label: z.string(),
  value: z.string(),
  source: z.enum(["user", "ai"]),
});

export const interviewTurnOutput = z.object({
  note: z.string(),
  complete: z.boolean(),
  question: z.string(),
  rationale: z.string(),
  recommendation: z.string(),
  facts: z.array(interviewFact),
  unresolved: z.array(z.string()),
});
export type InterviewTurnOutput = z.infer<typeof interviewTurnOutput>;

export type InterviewExchange = { question: string; answer: string };

type TurnState = { note: string; context: StoryContext; collected: CollectedItem[] };

export type ResolvedInterviewTurn =
  | ({ status: "ask"; question: string; rationale: string } & TurnState)
  | ({ status: "complete"; recommendation: string } & TurnState);

function normalizeQuestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const LIST_MARKER = /^(?:[-*•–]|\(?\d{1,2}[.)]|\(?[a-z]\))\s+/i;
const INLINE_ENUMERATION = /(?<=[?.!:])\s+(?=\(?\d{1,2}[.)]\s)/;
const QUESTION_SENTENCE = /[^?]*\?+["'”’)\]]*/g;

/** Keeps one main question plus at most one follow-up (e.g. options); a list of questions keeps only its first. */
export function tidyQuestion(value: string): string {
  const items = value
    .split(/\r?\n/)
    .flatMap((line) => line.split(INLINE_ENUMERATION))
    .map((item) => item.trim())
    .filter(Boolean);
  const listedQuestions = items.filter((item) => LIST_MARKER.test(item) && item.includes("?")).length;
  const text = items
    .map((item) => item.replace(LIST_MARKER, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const questions = text.match(QUESTION_SENTENCE);
  if (!questions) return text;
  return questions
    .slice(0, listedQuestions >= 2 ? 1 : 2)
    .join("")
    .trim();
}

// Interrogatives stay meaningful ("where" vs "when"); only function words and domain filler are ignored.
const STOP_WORDS = new Set(
  "a an the and or but of to in on at for with about from by as into onto than then so if is are was were be been being am do does did have has had will would should could can may might shall must it its this that these those there here they them their he him his she her hers you your yours we us our i me my mine one any some most more very really actually exactly just also else please tell kind sort type story film movie project piece"
    .split(" "),
);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/['’]s\b/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
      .map((word) => (word === "which" ? "what" : word))
      .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)),
  );
}

export const NEAR_DUPLICATE_SIMILARITY = 0.8;

/** Same question reworded: content-word Jaccard similarity with any earlier question reaches the threshold. */
export function isNearDuplicate(question: string, previousQuestions: readonly string[]): boolean {
  const normalized = normalizeQuestion(question);
  const words = contentWords(question);
  return previousQuestions.some((previous) => {
    if (normalizeQuestion(previous) === normalized) return true;
    const other = contentWords(previous);
    if (words.size === 0 || other.size === 0) return false;
    let shared = 0;
    for (const word of words) if (other.has(word)) shared += 1;
    return shared / (words.size + other.size - shared) >= NEAR_DUPLICATE_SIMILARITY;
  });
}

const DEFAULT_RECOMMENDATION = "Enough is gathered to plan the shots — continue to story planning.";
export const STOP_RECOMMENDATION = "Creating your plan now.";

// Mirrors storyContextSchema limits so the returned context is accepted when the client sends it back.
const clip = (text: string, max: number) => text.trim().slice(0, max);

const MAX_NOTE_CHARACTERS = 200;
const MAX_RATIONALE_CHARACTERS = 200;

function clipAtWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** The filmmaker's latest answer is a whole-message stop command ("stop", "proceed", "generate plan"…). */
export function isStopRequest(answered: InterviewExchange[]): boolean {
  const last = answered.at(-1);
  return last !== undefined && detectDiscoveryCommand(last.answer) === "stop";
}

/** Deterministic completion for a stop command — no model call, context unchanged. */
export function stopTurn(context: StoryContext): ResolvedInterviewTurn {
  return { status: "complete", note: "", recommendation: STOP_RECOMMENDATION, context, collected: toCollected(context) };
}

export function resolveInterviewTurn(
  output: InterviewTurnOutput,
  answered: InterviewExchange[],
  context: StoryContext,
  maxTurns: number = MAX_INTERVIEW_TURNS,
): ResolvedInterviewTurn {
  const updates: ContextFact[] = output.facts.map((fact) => ({
    category: fact.category,
    label: clip(fact.label, 80),
    value: clip(fact.value, 600),
    source: fact.source,
    approved: fact.source === "user",
  }));
  const merged = withUnresolved(
    mergeFacts(context, updates),
    output.unresolved.map((item) => clip(item, 300)),
  );
  const state = {
    note: clipAtWord(output.note, MAX_NOTE_CHARACTERS),
    context: merged,
    collected: toCollected(merged),
  };

  const question = clip(tidyQuestion(output.question), 500);
  const isDuplicate =
    question.length > 0 &&
    isNearDuplicate(
      question,
      answered.map((exchange) => exchange.question),
    );
  const capReached = answered.length >= maxTurns;

  if (output.complete || question.length === 0 || isDuplicate || capReached) {
    return { status: "complete", recommendation: clip(output.recommendation, 600) || DEFAULT_RECOMMENDATION, ...state };
  }

  return { status: "ask", question, rationale: clipAtWord(output.rationale, MAX_RATIONALE_CHARACTERS), ...state };
}
