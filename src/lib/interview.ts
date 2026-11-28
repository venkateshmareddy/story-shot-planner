import { z } from "zod";
import {
  type ContextFact,
  DECIDE_ANSWER,
  detectDiscoveryCommand,
  factKey,
  MAX_VISUAL_QUESTIONS,
  mergeFacts,
  SKIPPED_ANSWER,
  type StoryContext,
  sameFactValue,
  toCollected,
  VISUAL_KINDS,
  type VisualEntity,
  withUnresolved,
} from "./story-context";
import { storyCategorySchema } from "./story-context-schema";
import { MAX_ANSWER_CHARACTERS } from "./story-input";
import { inferAsks,
  closeSkipped,
  findVisual,
  lookChoiceLine,
  markAsked,
  openLooks,
  sameVisual,
  seedConditions,
  trackVisuals,
} from "./visual-discovery";

export const MAX_INTERVIEW_TURNS = 12;

/** Text sent after discovery is complete; it goes to the plan, not the interview. */
export const EXTRA_DIRECTION_QUESTION = "Additional direction";
export const MAX_EXTRA_DIRECTIONS = 8;
export const MAX_PLAN_ANSWERS = MAX_INTERVIEW_TURNS + MAX_EXTRA_DIRECTIONS;

/**
 * Adds a late direction without ever blocking the filmmaker: past MAX_EXTRA_DIRECTIONS (or MAX_PLAN_ANSWERS) it is
 * merged into the last direction, keeping the newest text when the merged answer is too long. Pure.
 */
export function addExtraDirection(answered: InterviewExchange[], text: string): InterviewExchange[] {
  const direction = text.trim().slice(0, MAX_ANSWER_CHARACTERS);
  if (!direction) return answered;
  const extras = answered.filter((exchange) => exchange.question === EXTRA_DIRECTION_QUESTION).length;
  if (extras < MAX_EXTRA_DIRECTIONS && answered.length < MAX_PLAN_ANSWERS) {
    return [...answered, { question: EXTRA_DIRECTION_QUESTION, answer: direction }];
  }
  const lastIndex = answered.findLastIndex((exchange) => exchange.question === EXTRA_DIRECTION_QUESTION);
  const index = lastIndex === -1 ? answered.length - 1 : lastIndex;
  const merged = `${answered[index].answer}\n${direction}`;
  const answer = merged.length <= MAX_ANSWER_CHARACTERS ? merged : merged.slice(merged.length - MAX_ANSWER_CHARACTERS).replace(/^\S*\s/, "");
  return answered.map((exchange, position) => (position === index ? { question: EXTRA_DIRECTION_QUESTION, answer } : exchange));
}

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

export const interviewVisual = z.object({
  name: z.string(),
  kind: z.enum(VISUAL_KINDS),
  key: z.boolean(),
  central: z.boolean(),
  look: z.string(),
  source: z.enum(["user", "ai"]),
});

export const interviewTurnOutput = z.object({
  note: z.string(),
  complete: z.boolean(),
  /** The VISUAL GAPS name this question is about; "" for a story question. */
  asks: z.string(),
  question: z.string(),
  /** Short tappable answer choices; [] for an open question. */
  options: z.array(z.string()),
  rationale: z.string(),
  recommendation: z.string(),
  facts: z.array(interviewFact),
  visuals: z.array(interviewVisual),
  unresolved: z.array(z.string()),
});
export type InterviewTurnOutput = z.infer<typeof interviewTurnOutput>;

export type InterviewExchange = { question: string; answer: string };

type TurnState = { note: string; context: StoryContext; collected: CollectedItem[] };

export type ResolvedInterviewTurn =
  | ({ status: "ask"; question: string; options: string[]; rationale: string } & TurnState)
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
export const MAX_OPTIONS = 4;
export const MAX_OPTION_CHARACTERS = 60;

function clipAtWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** Tappable answer choices: trimmed, non-empty, de-duplicated, at most MAX_OPTIONS, each clipped at a word boundary. */
export function tidyOptions(options: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of options) {
    const text = clipAtWord(option, MAX_OPTION_CHARACTERS);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length === MAX_OPTIONS) break;
  }
  return result;
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

/**
 * A fact is the filmmaker's only when they actually said it. Deterministic guards:
 * 1. A restatement of an existing filmmaker fact (same key and value) stays theirs, tied to its original answer.
 * 2. Title-only first turn (no answers, no imported story): nothing has been said yet, so every fact is an AI guess.
 * 3. A skipped or "you decide" latest answer states nothing, so any new detail is the AI's choice.
 * 4. The model can't promote its own unchanged earlier suggestion to "user" — only the filmmaker's Approve does that.
 * Filmmaker facts record the answer they came from, so editing that answer can retract them.
 */
export function attributeFacts(
  facts: InterviewTurnOutput["facts"],
  answered: InterviewExchange[],
  context: StoryContext,
  titleOnly: boolean,
): ContextFact[] {
  const nothingSaid = titleOnly && answered.length === 0;
  const latest = answered.at(-1)?.answer;
  const deferred = latest === DECIDE_ANSWER || latest === SKIPPED_ANSWER;
  return facts.map((fact) => {
    const label = clip(fact.label, 80);
    const value = clip(fact.value, 600);
    const existing = context.facts.find((item) => factKey(item) === factKey({ category: fact.category, label }));
    const unchanged = existing !== undefined && sameFactValue(existing.value, value);
    if (fact.source === "user" && existing?.source === "user" && unchanged) return { ...existing };
    let source = fact.source;
    if (source === "user" && (nothingSaid || deferred)) source = "ai";
    if (source === "user" && existing?.source === "ai" && !existing.approved && unchanged) source = "ai";
    const answer = source === "user" && answered.length > 0 ? { answer: answered.length - 1 } : {};
    return { category: fact.category, label, value, source, approved: source === "user", ...answer };
  });
}

export type VisualGaps = { left: number; gaps: VisualEntity[] };

// None before idea, genre and format; one look question beyond the limit only ever goes to the thing the story revolves around.
export function visualGaps(context: StoryContext, answered: readonly InterviewExchange[]): VisualGaps {
  // Not gated on readiness: genre/format often settle in the same turn the model decides to stop (live finding).
  const open = openLooks(context);
  const asked = (context.visuals ?? []).filter((entity) => entity.asked !== undefined);
  const centralAsked = asked.some((entity) => entity.central);
  let left = MAX_VISUAL_QUESTIONS - asked.length + (centralAsked ? 1 : 0);
  let gaps = open;
  if (left <= 0) {
    gaps = centralAsked ? [] : open.filter((entity) => entity.central);
    left = gaps.length ? 1 : 0;
  }
  left = Math.min(left, Math.max(0, MAX_INTERVIEW_TURNS - answered.length));
  return left > 0 ? { left, gaps } : { left: 0, gaps: [] };
}

function withLookChoice(recommendation: string, context: StoryContext): string {
  const line = lookChoiceLine(context);
  return line ? `${recommendation} ${line}` : recommendation;
}

export function resolveInterviewTurn(
  output: InterviewTurnOutput,
  answered: InterviewExchange[],
  context: StoryContext,
  maxTurns: number = MAX_INTERVIEW_TURNS,
  options: { titleOnly?: boolean } = {},
): ResolvedInterviewTurn {
  const tracked = trackVisuals(context, output.visuals);
  const lookKeys = new Set(tracked.looks.map(factKey));
  const modelFacts = output.facts.filter((fact) => !lookKeys.has(factKey({ category: fact.category, label: clip(fact.label, 80) })));
  const updates = attributeFacts([...modelFacts, ...tracked.looks], answered, tracked.context, options.titleOnly ?? false);
  const merged = closeSkipped(
    seedConditions(
      context.visuals ?? [],
      withUnresolved(
        mergeFacts(tracked.context, updates),
        output.unresolved.map((item) => clip(item, 300)),
      ),
    ),
    answered.length,
    answered.at(-1)?.answer === SKIPPED_ANSWER,
  );
  const note = clipAtWord(output.note, MAX_NOTE_CHARACTERS);

  const question = clip(tidyQuestion(output.question), 500);
  const target = output.asks.trim()
    ? findVisual(merged.visuals ?? [], clip(output.asks, 200))
    : inferAsks(question, visualGaps(merged, answered).gaps);
  const repeat = target !== undefined && (target.asked !== undefined || target.closed === true);
  const openGap = target !== undefined && !repeat && visualGaps(merged, answered).gaps.some((gap) => sameVisual(gap, target));
  // Looks of different things read alike ("the beach house" vs "the house"); a look question is checked by what it names.
  const isDuplicate =
    question.length > 0 &&
    !openGap &&
    isNearDuplicate(
      question,
      answered.map((exchange) => exchange.question),
    );
  const capReached = answered.length >= maxTurns;

  if (output.complete || question.length === 0 || isDuplicate || repeat || capReached) {
    const recommendation = withLookChoice(clip(output.recommendation, 600) || DEFAULT_RECOMMENDATION, merged);
    return { status: "complete", recommendation, note, context: merged, collected: toCollected(merged) };
  }

  const asked = target ? markAsked(merged, target, answered.length) : merged;
  return {
    status: "ask",
    question,
    options: tidyOptions(output.options),
    rationale: clipAtWord(output.rationale, MAX_RATIONALE_CHARACTERS),
    note,
    context: asked,
    collected: toCollected(asked),
  };
}
