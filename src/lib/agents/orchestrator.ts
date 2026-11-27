import {
  type CallModel,
  deadline,
  type ModelErrorMetadata,
  ModelOutputError,
  modelErrorMetadata,
  untilAborted,
} from "@/lib/server/openai";
import { ANALYSIS_STYLE, DIRECTOR_PERSONA, PLAIN_LANGUAGE, SOURCE_RULES } from "@/lib/server/prompts";
import type { RefineResult } from "@/lib/server/refine";
import { categoryOf, PRIORITY_ORDER } from "@/lib/story-context";
import type { RefineRequest } from "@/lib/story-planning";
import type { UsageRecord } from "@/lib/usage";
import { cinematographyDirector } from "./cinematography-director";
import { continuityReviewer } from "./continuity-reviewer";
import { editingDirector } from "./editing-director";
import { mergeEdits, sanitizeEdits, type ValidEdit } from "./merge";
import { domainScore, selectSpecialists } from "./router";
import { anySpecialistOutput, type SpecialistOutput, synthesisOutput } from "./schemas";
import {
  clip,
  factStatus,
  MAX_SPECIALIST_RECOMMENDATIONS,
  recentDecisions,
  type SpecialistDefinition,
  specialistContext,
} from "./shared";
import { soundDirector } from "./sound-director";
import { storyAnalyst } from "./story-analyst";
import {
  type DirectorRequest,
  type DirectorResponse,
  type Recommendation,
  SPECIALIST_IDS,
  SPECIALIST_LABELS,
  type SpecialistId,
} from "./types";

export const SPECIALISTS: Readonly<Record<SpecialistId, SpecialistDefinition>> = Object.freeze({
  "story-analyst": storyAnalyst,
  "cinematography-director": cinematographyDirector,
  "sound-director": soundDirector,
  "editing-director": editingDirector,
  "continuity-reviewer": continuityReviewer,
});

export { type CallModel, type ModelCall, ModelOutputError } from "@/lib/server/openai";

export type DirectorDeps = {
  callModel: CallModel;
  refine: (input: RefineRequest) => Promise<RefineResult>;
};

/** Metadata-only diagnosis of one failed specialist call. */
export type SpecialistFailure = ModelErrorMetadata & { id: SpecialistId; maxOutputTokens: number };

export type DirectorOptions = {
  signal?: AbortSignal;
  specialistTimeoutMs?: number;
  synthesisTimeoutMs?: number;
  /** Called once per failed specialist, whether or not the rest of the team succeeded. */
  onSpecialistFailure?: (failure: SpecialistFailure) => void;
};

/** Every selected specialist failed. */
export class DirectorError extends Error {
  constructor(
    readonly failed: SpecialistId[],
    readonly causes: unknown[],
  ) {
    super("The creative team couldn't respond");
    this.name = "DirectorError";
  }
}

export const SPECIALIST_TIMEOUT_MS = 90_000;
export const SYNTHESIS_TIMEOUT_MS = 30_000;
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 1_200;
// Total findings handed to synthesis stays at the old 5 x 3; fewer specialists get deeper coverage each.
const SYNTHESIS_RECOMMENDATION_BUDGET = 15;
const SYNTHESIS_MAX_ESTABLISHED = 8;
const FALLBACK_POINTS_PER_SPECIALIST = 2;
const MAX_CONFLICTS = 8;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

const SYNTHESIS_INSTRUCTIONS = [
  SOURCE_RULES,
  DIRECTOR_PERSONA,
  PLAIN_LANGUAGE,
  ANALYSIS_STYLE,
  "Your specialist team has studied the plan for this request; now you answer the filmmaker yourself. The input holds the filmmaker's message, what the filmmaker has established (established, may be empty), each specialist's findings by discipline (specialists), disciplines that could not respond (failed), deterministic edit conflicts (mergeConflicts) and the plan changes proposed for the filmmaker's approval (proposedChanges).",
  'reply: ONE coherent Creative Director voice speaking to the filmmaker, never a relay of separate reports ("the Camera expert says"). The first line is a one-line plain answer to the message. Match the length to the request: about 60-150 words for a focused question, up to about 350 words for a review across several areas. When two or more areas matter, give each a label line such as "Story:", "Camera:", "Sound:", "Editing:" or "Consistency:" followed by "- " bullets, the most important point first and tied to scene or shot ids. Say each point once, even when several specialists raise it. Where specialists disagree or a choice trades one quality for another, explain the trade-off and name the alternative. Keep three things visibly distinct: what the filmmaker established, what is assumed (say so), and what you recommend. Use only findings present in the input; add no new recommendations. If proposedChanges is not empty, end by saying those changes wait for their approval; if failed is not empty, say in one short clause which area could not respond.',
  "conflicts: one sentence per genuine disagreement or trade-off between specialists, including every mergeConflicts entry, naming the alternative the filmmaker could choose; [] when there is none.",
].join("\n");

type SpecialistResult = {
  id: SpecialistId;
  output: SpecialistOutput;
  usage: UsageRecord;
};

function approvedContext(input: DirectorRequest, id: SpecialistId) {
  const collected = (input.collected ?? [])
    .map((item, index) => ({ item, index, score: domainScore(`${item.label} ${item.detail}`, id) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 12)
    .map(({ item }) => ({ label: clip(item.label, 80), detail: clip(item.detail, 240) }));
  if (collected.length) return { collected };
  const answers = (input.answers ?? [])
    .slice(-6)
    .map(({ question, answer }) => ({ question: clip(question, 160), answer: clip(answer, 300) }));
  return { answers };
}

/** Structured StoryContext when the client sent one; the flat interview/collected list for older sessions. */
function projectContext(input: DirectorRequest, definition: SpecialistDefinition) {
  const { context } = input;
  if (context && (context.facts.length || context.unresolved.length)) {
    return { context: specialistContext(context, definition.id, definition.contextCategories) };
  }
  return { approved: approvedContext(input, definition.id) };
}

/** Filmmaker and approved facts across all categories, most important category first. */
function establishedFacts(input: DirectorRequest) {
  if (!input.context) return [];
  return input.context.facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => factStatus(fact) !== "ai_suggestion")
    .sort(
      (a, b) =>
        PRIORITY_ORDER[categoryOf(a.fact.category).priority] - PRIORITY_ORDER[categoryOf(b.fact.category).priority] ||
        a.index - b.index,
    )
    .slice(0, SYNTHESIS_MAX_ESTABLISHED)
    .map(({ fact }) => `${categoryOf(fact.category).label}, ${clip(fact.label, 60)}: ${clip(fact.value, 160)}`);
}

async function consult(
  definition: SpecialistDefinition,
  input: DirectorRequest,
  deps: DirectorDeps,
  options: DirectorOptions,
): Promise<SpecialistResult> {
  const timeoutMs = options.specialistTimeoutMs ?? SPECIALIST_TIMEOUT_MS;
  const signal = deadline(options.signal, timeoutMs);
  const payload = {
    message: input.message,
    recent: input.messages.slice(-4).map(({ role, text }) => ({ role, text: clip(text, 300) })),
    ...projectContext(input, definition),
    decisions: recentDecisions(input.decisions),
    ...(definition.readsSource && input.source ? { source: input.source } : {}),
    plan: definition.buildContext(input.plan, input.references),
  };
  const { output, usage } = await untilAborted(
    deps.callModel({
      step: definition.id,
      instructions: definition.instructions,
      input: JSON.stringify(payload),
      schema: definition.schema,
      maxOutputTokens: definition.maxOutputTokens,
      signal,
      timeoutMs,
    }),
    signal,
  );
  const parsed = anySpecialistOutput.safeParse(output);
  if (!parsed.success || !parsed.data.summary.trim()) {
    throw new ModelOutputError("Invalid specialist output", usage, "invalid_output");
  }
  return { id: definition.id, output: parsed.data, usage };
}

export function describeSpecialistFailure(id: SpecialistId, cause: unknown): SpecialistFailure {
  return { id, ...modelErrorMetadata(cause), maxOutputTokens: SPECIALISTS[id].maxOutputTokens };
}

/** Shown when every selected specialist failed. */
export function directorFailureMessage(failed: readonly SpecialistId[]) {
  const who = failed.length === 1 ? `The ${SPECIALIST_LABELS[failed[0]]} expert` : "The creative team";
  return `${who} couldn’t finish this time. Try again, or ask about one scene.`;
}

function toRecommendations(results: SpecialistResult[]): Recommendation[] {
  return results
    .flatMap(({ id, output }) =>
      output.recommendations
        .filter(({ recommendation }) => recommendation.trim())
        .slice(0, MAX_SPECIALIST_RECOMMENDATIONS)
        .map((item) => ({
          specialist: id,
          target: clip(item.target, 80) || "Overall",
          issue: clip(item.issue, 400),
          recommendation: clip(item.recommendation, 600),
          rationale: clip(item.rationale, 400),
          priority: item.priority,
        })),
    )
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

function fallbackPoint(target: string, recommendation: string) {
  const where = clip(target, 80);
  return `- ${where && where !== "Overall" ? `${where}: ` : ""}${clip(recommendation, 300)}`;
}

/** Deterministic reply when synthesis is skipped or fails: one label line per discipline, summary, top points. */
function fallbackReply(results: SpecialistResult[]) {
  if (results.length === 1) return results[0].output.summary.trim();
  return results
    .map(({ id, output }) =>
      [
        `${SPECIALIST_LABELS[id]}:`,
        output.summary.trim(),
        ...output.recommendations
          .filter(({ recommendation }) => recommendation.trim())
          .slice(0, FALLBACK_POINTS_PER_SPECIALIST)
          .map(({ target, recommendation }) => fallbackPoint(target, recommendation)),
      ].join("\n"),
    )
    .join("\n\n");
}

async function synthesize(
  input: DirectorRequest,
  results: SpecialistResult[],
  failed: SpecialistId[],
  mergeConflicts: string[],
  changeSummary: string[],
  deps: DirectorDeps,
  options: DirectorOptions,
  usage: UsageRecord[],
): Promise<{ reply: string; conflicts: string[] } | null> {
  const signal = deadline(options.signal, options.synthesisTimeoutMs ?? SYNTHESIS_TIMEOUT_MS);
  const perSpecialist = Math.min(
    MAX_SPECIALIST_RECOMMENDATIONS,
    Math.max(2, Math.floor(SYNTHESIS_RECOMMENDATION_BUDGET / results.length)),
  );
  const payload = {
    message: clip(input.message, 1_000),
    established: establishedFacts(input),
    specialists: results.map(({ id, output }) => ({
      discipline: SPECIALIST_LABELS[id],
      summary: clip(output.summary, 800),
      recommendations: output.recommendations
        .filter(({ recommendation }) => recommendation.trim())
        .slice(0, perSpecialist)
        .map(({ target, issue, recommendation, rationale, priority }) => ({
          target: clip(target, 80),
          priority,
          issue: clip(issue, 200),
          recommendation: clip(recommendation, 300),
          rationale: clip(rationale, 200),
        })),
    })),
    failed: failed.map((id) => SPECIALIST_LABELS[id]),
    mergeConflicts,
    proposedChanges: changeSummary.slice(0, 12),
  };
  try {
    const result = await untilAborted(
      deps.callModel({
        step: "orchestrator",
        instructions: SYNTHESIS_INSTRUCTIONS,
        input: JSON.stringify(payload),
        schema: synthesisOutput,
        maxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
        signal,
      }),
      signal,
    );
    usage.push(result.usage);
    const parsed = synthesisOutput.safeParse(result.output);
    if (!parsed.success || !parsed.data.reply.trim()) return null;
    return { reply: parsed.data.reply.trim(), conflicts: parsed.data.conflicts.map((text) => clip(text, 400)) };
  } catch (error) {
    if (error instanceof ModelOutputError) usage.push(error.usage);
    return null;
  }
}

/**
 * General plan edit (no specialist matched). runRefine decides what changes, renames in code and rewrites only the
 * scenes that need it, using the scenes the message names as a hint. No change means no proposal: plan is null.
 */
async function refineFallback(input: DirectorRequest, deps: DirectorDeps): Promise<DirectorResponse> {
  const { plan, messages, message, decisions, source } = input;
  const result = await deps.refine({
    plan,
    messages,
    message,
    ...(decisions ? { decisions } : {}),
    ...(source ? { source } : {}),
  });
  return {
    mode: "refine",
    reply: result.reply,
    specialists: [],
    failed: [],
    recommendations: [],
    conflicts: [],
    changeSummary: result.changed ? result.changeSummary : [],
    plan: result.changed ? result.plan : null,
    usage: result.usage,
  };
}

/**
 * Multi-agent Creative Director. Bounded: at most 5 specialist calls in parallel plus 1 synthesis call,
 * or one plan edit (1 decision call plus at most MAX_PLAN_SCENES scene calls in parallel), no recursion. Specialists only propose; the merged plan is a copy awaiting the filmmaker's Apply.
 */
export async function runDirector(
  input: DirectorRequest,
  deps: DirectorDeps,
  options: DirectorOptions = {},
): Promise<DirectorResponse> {
  const selected = selectSpecialists(input.message).slice(0, SPECIALIST_IDS.length);
  if (!selected.length) return refineFallback(input, deps);

  const settled = await Promise.allSettled(
    selected.map((id) => consult(SPECIALISTS[id], input, deps, options)),
  );
  const usage: UsageRecord[] = [];
  const results: SpecialistResult[] = [];
  const failed: SpecialistId[] = [];
  const causes: unknown[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      usage.push(outcome.value.usage);
      return;
    }
    failed.push(selected[index]);
    causes.push(outcome.reason);
    options.onSpecialistFailure?.(describeSpecialistFailure(selected[index], outcome.reason));
    if (outcome.reason instanceof ModelOutputError) usage.push(outcome.reason.usage);
  });
  if (!results.length) throw new DirectorError(failed, causes);

  const edits: ValidEdit[] = results.flatMap(({ id, output }) =>
    sanitizeEdits(input.plan, id, SPECIALISTS[id].fields, output.edits),
  );
  const merged = mergeEdits(input.plan, edits);

  const synthesis =
    results.length >= 2
      ? await synthesize(input, results, failed, merged.conflicts, merged.changeSummary, deps, options, usage)
      : null;

  return {
    mode: "specialists",
    reply: synthesis?.reply ?? fallbackReply(results),
    specialists: results.map(({ id }) => id),
    failed,
    recommendations: toRecommendations(results),
    conflicts: [...new Set([...merged.conflicts, ...(synthesis?.conflicts ?? [])])]
      .filter((text) => text.trim())
      .slice(0, MAX_CONFLICTS),
    changeSummary: merged.changeSummary,
    plan: merged.plan,
    usage,
  };
}
