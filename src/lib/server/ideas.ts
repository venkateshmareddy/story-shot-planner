import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { clip } from "@/lib/agents/shared";
import { DEFAULT_FORMAT } from "@/lib/formats";
import {
  type ConceptDigest,
  conceptDigest,
  type IdeasRequest,
  type IdeasResponse,
  MAX_AVOID,
  MAX_COMBINE,
  MAX_CONCEPTS,
  MAX_IDEA_QUESTIONS,
  MIN_CONCEPTS,
  type StoryConcept,
  SURPRISE_ME,
} from "@/lib/ideas";
import { STORY_MODEL } from "@/lib/models";
import { cacheWriteTokens, logModelUsage, modelRequest } from "@/lib/server/openai";
import { composeInstructions } from "@/lib/server/prompts";
import { toUsageRecord, type UsageRecord } from "@/lib/usage";

export const IDEAS_BODY_BYTES = 64_000;
export const IDEAS_GENERATE_MAX_OUTPUT_TOKENS = 2_500;
export const IDEAS_SINGLE_MAX_OUTPUT_TOKENS = 900;
/** Below the route's maxDuration so a slow call fails cleanly instead of being killed by the platform. */
export const IDEAS_TIMEOUT_MS = 55_000;
/** Content-word (Dice) similarity of title + premise at or above which two concepts count as the same idea. */
export const DUPLICATE_SIMILARITY = 0.6;

export const IDEA_DIRECTION_MAX = 300;
export const IDEA_QUESTION_MAX = 500;
export const IDEA_ANSWER_MAX = 1_000;
export const IDEA_CHANGE_MAX = 1_000;
export const IDEA_NOTE_MAX = 500;
export const IDEA_OPTION_MAX = 120;
export const MAX_IDEA_OPTIONS = 5;
const CONCEPT_ID_MAX = 100;

type ConceptField = Exclude<keyof StoryConcept, "id">;

/** Shared by request validation and output clipping, so any concept this server returns is a valid request input. */
export const CONCEPT_FIELD_MAX: Record<ConceptField, number> = {
  title: 100,
  genre: 80,
  premise: 500,
  mainCharacter: 300,
  conflict: 300,
  emotionalHook: 300,
  plotDirection: 300,
  cinematicAppeal: 300,
};
const CONCEPT_FIELDS = Object.keys(CONCEPT_FIELD_MAX) as ConceptField[];
const CORE_FIELDS: readonly ConceptField[] = ["title", "genre", "premise", "mainCharacter", "conflict"];

export const IDEAS_NOT_ENOUGH_MESSAGE = "I couldn't come up with enough distinct ideas. Try again or give me a direction.";
export const IDEAS_INCOMPLETE_MESSAGE = "I couldn't finish these ideas. Try again.";
const SINGLE_FAILURE_MESSAGE = {
  another: "I couldn't come up with an idea different enough from the ones you've seen. Try again.",
  refine: "I couldn't rework this idea. Try again or describe the change differently.",
  combine: "I couldn't combine these ideas into a new one. Try again or pick different ideas.",
} as const;

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1).max(max);
const isCore = (field: ConceptField) => CORE_FIELDS.includes(field);

const conceptInput = z.object({
  id: text(CONCEPT_ID_MAX),
  ...(Object.fromEntries(
    CONCEPT_FIELDS.map((field) => [field, isCore(field) ? required(CONCEPT_FIELD_MAX[field]) : text(CONCEPT_FIELD_MAX[field])]),
  ) as Record<ConceptField, z.ZodString>),
});

const exchange = z.object({ question: text(IDEA_QUESTION_MAX), answer: text(IDEA_ANSWER_MAX) });
const digest = z.object({ title: text(CONCEPT_FIELD_MAX.title), premise: text(CONCEPT_FIELD_MAX.premise) });
const discovery = {
  direction: text(IDEA_DIRECTION_MAX),
  answers: z.array(exchange).max(MAX_IDEA_QUESTIONS),
  avoid: z.array(digest).max(MAX_AVOID),
};

export const ideasRequest = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("generate"), ...discovery }),
  z.object({ mode: z.literal("another"), ...discovery }),
  z.object({ mode: z.literal("refine"), concept: conceptInput, change: required(IDEA_CHANGE_MAX) }),
  z.object({ mode: z.literal("combine"), concepts: z.array(conceptInput).min(2).max(MAX_COMBINE), note: text(IDEA_NOTE_MAX) }),
]) satisfies z.ZodType<IdeasRequest>;

const conceptOutput = z.object(
  Object.fromEntries(CONCEPT_FIELDS.map((field) => [field, z.string()])) as Record<ConceptField, z.ZodString>,
);

/** Flat structured-output schema: a question (generate only) or concepts, never a root union. */
export const ideasModelOutput = z.object({
  question: z.string(),
  options: z.array(z.string()),
  concepts: z.array(conceptOutput),
});
export type IdeasModelOutput = z.infer<typeof ideasModelOutput>;

export type IdeasModelCall = {
  instructions: string;
  input: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
};

/** Output is treated as unknown and re-validated by runIdeas. */
export type IdeasCallModel = (call: IdeasModelCall) => Promise<{ output: unknown; usage: UsageRecord }>;

/** The model call returned (and cost tokens) but gave no usable result. `message` is safe to show the filmmaker. */
export class IdeasError extends Error {
  constructor(
    message: string,
    readonly reason: "incomplete" | "not_enough" | "no_valid_concept",
    readonly usage: UsageRecord,
  ) {
    super(message);
    this.name = "IdeasError";
  }
}

export function openAIIdeasModel(client: Pick<OpenAI, "responses">): IdeasCallModel {
  return async ({ instructions, input, maxOutputTokens, signal }) => {
    const format = zodTextFormat(ideasModelOutput, "story_ideas");
    const request = modelRequest("ideas", { instructions, input, format, maxOutputTokens });
    const response = await client.responses.parse(request, { signal });
    const model = response.model || request.model || STORY_MODEL;
    const usage = toUsageRecord("ideas", model, response.usage);
    const written = cacheWriteTokens(response.usage);
    logModelUsage({ step: "ideas", stage: "ideas", model, usage, cacheWriteTokens: written });
    if (response.status !== "completed" || !response.output_parsed) {
      throw new IdeasError(IDEAS_INCOMPLETE_MESSAGE, "incomplete", usage);
    }
    return { output: response.output_parsed, usage };
  };
}

/** Generate must return concepts once the filmmaker asked to be surprised or has answered every allowed question. */
export function mustReturnConcepts(request: Extract<IdeasRequest, { mode: "generate" }>): boolean {
  return request.direction.trim().toLowerCase() === SURPRISE_ME.toLowerCase() || request.answers.length >= MAX_IDEA_QUESTIONS;
}

export type RunIdeasOptions = { signal?: AbortSignal; timeoutMs?: number };

/** One model call; deterministic question/concept rules, cleaning and de-duplication. */
export async function runIdeas(
  request: IdeasRequest,
  callModel: IdeasCallModel,
  options: RunIdeasOptions = {},
): Promise<IdeasResponse> {
  const questionAllowed = request.mode === "generate" && !mustReturnConcepts(request);
  const signals = [AbortSignal.timeout(options.timeoutMs ?? IDEAS_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);

  const { output, usage } = await callModel({
    instructions: composeInstructions("ideas", DEFAULT_FORMAT),
    input: JSON.stringify(modelInput(request, questionAllowed)),
    maxOutputTokens: request.mode === "generate" ? IDEAS_GENERATE_MAX_OUTPUT_TOKENS : IDEAS_SINGLE_MAX_OUTPUT_TOKENS,
    signal: AbortSignal.any(signals),
  });
  const parsed = ideasModelOutput.safeParse(output);
  if (!parsed.success) throw new IdeasError(IDEAS_INCOMPLETE_MESSAGE, "incomplete", usage);

  if (questionAllowed) {
    const question = cleanQuestion(parsed.data);
    if (question) return { question, concepts: [], usage };
  }

  const candidates = distinctConcepts(parsed.data.concepts, excludedDigests(request));
  if (request.mode === "generate") {
    if (candidates.length < MIN_CONCEPTS) throw new IdeasError(IDEAS_NOT_ENOUGH_MESSAGE, "not_enough", usage);
    return { question: null, concepts: candidates.slice(0, MAX_CONCEPTS).map(withId), usage };
  }

  const original = request.mode === "refine" ? fingerprint(request.concept) : null;
  const chosen = candidates.find((concept) => fingerprint(concept) !== original);
  if (!chosen) throw new IdeasError(SINGLE_FAILURE_MESSAGE[request.mode], "no_valid_concept", usage);
  return { question: null, concepts: [withId(chosen)], usage };
}

function modelInput(request: IdeasRequest, questionAllowed: boolean) {
  switch (request.mode) {
    case "generate":
    case "another":
      return { ...request, questionAllowed };
    case "refine":
      return { mode: request.mode, concept: withoutId(request.concept), change: request.change, questionAllowed };
    case "combine":
      return { mode: request.mode, concepts: request.concepts.map(withoutId), note: request.note, questionAllowed };
  }
}

/** Concepts a result must not repeat. A refinement is checked only against an unchanged copy of its original. */
function excludedDigests(request: IdeasRequest): ConceptDigest[] {
  if (request.mode === "generate" || request.mode === "another") return request.avoid;
  if (request.mode === "combine") return request.concepts.map(conceptDigest);
  return [];
}

type ConceptDraft = Omit<StoryConcept, "id">;

function withoutId({ id: _id, ...concept }: StoryConcept): ConceptDraft {
  return concept;
}

function withId(concept: ConceptDraft): StoryConcept {
  return { id: crypto.randomUUID(), ...concept };
}

function cleanText(value: string, max: number): string {
  return clip(value.replace(/\p{Cc}+/gu, " "), max);
}

function cleanConcept(raw: Record<ConceptField, string>): ConceptDraft | null {
  const concept = Object.fromEntries(
    CONCEPT_FIELDS.map((field) => {
      const value = field === "title" ? raw.title.replace(/^[\s"'“”‘’*]+|[\s"'“”‘’*]+$/g, "") : raw[field];
      return [field, cleanText(value, CONCEPT_FIELD_MAX[field])];
    }),
  ) as ConceptDraft;
  return CORE_FIELDS.every((field) => concept[field]) ? concept : null;
}

function cleanQuestion(output: IdeasModelOutput): IdeasResponse["question"] {
  const questionText = cleanText(output.question, IDEA_QUESTION_MAX);
  if (!questionText) return null;
  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of output.options) {
    const option = cleanText(raw, IDEA_OPTION_MAX);
    const key = option.toLowerCase();
    if (!option || seen.has(key)) continue;
    seen.add(key);
    options.push(option);
    if (options.length === MAX_IDEA_OPTIONS) break;
  }
  return { text: questionText, options };
}

type Comparable = { title: string; words: Set<string> };

function distinctConcepts(raw: IdeasModelOutput["concepts"], exclude: readonly ConceptDigest[]): ConceptDraft[] {
  const seen = exclude.map(comparable);
  const kept: ConceptDraft[] = [];
  for (const item of raw) {
    const concept = cleanConcept(item);
    if (!concept) continue;
    const candidate = comparable(concept);
    if (seen.some((other) => isNearDuplicate(candidate, other))) continue;
    seen.push(candidate);
    kept.push(concept);
  }
  return kept;
}

const STOP_WORDS = new Set(
  "the and for with from into onto upon that this these those their they them then than there who whom whose what when where which while after before about over under through until his her hers him its our ours your yours are was were has have had but not nor all any out only own each every must can could will would should may might one two".split(
    " ",
  ),
);

function contentWords(value: string): Set<string> {
  const words = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return new Set(words);
}

function normalTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/^(?:the|a|an)\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function comparable(concept: ConceptDigest): Comparable {
  return { title: normalTitle(concept.title), words: contentWords(`${concept.title} ${concept.premise}`) };
}

/** Dice coefficient of the content words of two concepts' title + premise, 0..1. */
export function conceptSimilarity(a: ConceptDigest, b: ConceptDigest): number {
  return similarity(comparable(a).words, comparable(b).words);
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function isNearDuplicate(a: Comparable, b: Comparable): boolean {
  return (a.title !== "" && a.title === b.title) || similarity(a.words, b.words) >= DUPLICATE_SIMILARITY;
}

/** Exact content of every field, ignoring case and spacing: detects a refinement returned unchanged. */
function fingerprint(concept: ConceptDraft): string {
  return CONCEPT_FIELDS.map((field) => concept[field].replace(/\s+/g, " ").trim().toLowerCase()).join("\n");
}
