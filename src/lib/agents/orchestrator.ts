import type { z } from "zod";
import type { RefineResult } from "@/lib/server/refine";
import { SOURCE_RULES } from "@/lib/server/prompts";
import type { RefineRequest } from "@/lib/story-planning";
import type { UsageRecord, UsageStep } from "@/lib/usage";
import { cinematographyDirector } from "./cinematography-director";
import { continuityReviewer } from "./continuity-reviewer";
import { editingDirector } from "./editing-director";
import { mergeEdits, sanitizeEdits, type ValidEdit } from "./merge";
import { domainScore, selectSpecialists } from "./router";
import { anySpecialistOutput, type SpecialistOutput, synthesisOutput } from "./schemas";
import { clip, type SpecialistDefinition } from "./shared";
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

export type ModelCall = {
  step: UsageStep;
  instructions: string;
  input: string;
  schema: z.ZodType;
  maxOutputTokens: number;
  signal: AbortSignal;
};

/** Output is treated as unknown and re-validated by the orchestrator. */
export type CallModel = (call: ModelCall) => Promise<{ output: unknown; usage: UsageRecord }>;

export type DirectorDeps = {
  callModel: CallModel;
  refine: (input: RefineRequest) => Promise<RefineResult>;
};

export type DirectorOptions = {
  signal?: AbortSignal;
  specialistTimeoutMs?: number;
  synthesisTimeoutMs?: number;
};

/** A model call that returned (and cost tokens) but produced no usable output. */
export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly usage: UsageRecord,
  ) {
    super(message);
    this.name = "ModelOutputError";
  }
}

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

const SPECIALIST_TIMEOUT_MS = 60_000;
const SYNTHESIS_TIMEOUT_MS = 30_000;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 700;
const MAX_RECOMMENDATIONS_PER_SPECIALIST = 4;
const MAX_CONFLICTS = 8;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

const SYNTHESIS_INSTRUCTIONS = [
  SOURCE_RULES,
  "You are the Creative Director leading a film's specialist team. The input holds the filmmaker's message, each specialist's findings (specialists), specialists that could not respond (failed), deterministic edit conflicts (mergeConflicts) and the plan changes proposed for the filmmaker's approval (proposedChanges).",
  "reply: one coherent Creative Director voice addressed to the filmmaker, 80-180 words. Answer the message, lead with the most important recommendations, credit each discipline briefly, explain why the advice matters for the film, and say that proposed changes wait for their approval. Do not add recommendations that are not in the input.",
  "conflicts: one sentence per genuine disagreement or trade-off between specialists, including every mergeConflicts entry, naming the alternative the filmmaker could choose; [] when there is none.",
].join("\n");

type SpecialistResult = {
  id: SpecialistId;
  output: SpecialistOutput;
  usage: UsageRecord;
};

function deadline(parent: AbortSignal | undefined, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Settles on abort even if the callee ignores the signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

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

async function consult(
  definition: SpecialistDefinition,
  input: DirectorRequest,
  deps: DirectorDeps,
  options: DirectorOptions,
): Promise<SpecialistResult> {
  const signal = deadline(options.signal, options.specialistTimeoutMs ?? SPECIALIST_TIMEOUT_MS);
  const payload = {
    message: input.message,
    recent: input.messages.slice(-4).map(({ role, text }) => ({ role, text: clip(text, 300) })),
    approved: approvedContext(input, definition.id),
    plan: definition.buildContext(input.plan),
  };
  const { output, usage } = await untilAborted(
    deps.callModel({
      step: definition.id,
      instructions: definition.instructions,
      input: JSON.stringify(payload),
      schema: definition.schema,
      maxOutputTokens: definition.maxOutputTokens,
      signal,
    }),
    signal,
  );
  const parsed = anySpecialistOutput.safeParse(output);
  if (!parsed.success || !parsed.data.summary.trim()) {
    throw new ModelOutputError("Invalid specialist output", usage);
  }
  return { id: definition.id, output: parsed.data, usage };
}

function toRecommendations(results: SpecialistResult[]): Recommendation[] {
  return results
    .flatMap(({ id, output }) =>
      output.recommendations
        .filter(({ recommendation }) => recommendation.trim())
        .slice(0, MAX_RECOMMENDATIONS_PER_SPECIALIST)
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

function fallbackReply(results: SpecialistResult[]) {
  if (results.length === 1) return results[0].output.summary.trim();
  return results.map(({ id, output }) => `${SPECIALIST_LABELS[id]}: ${output.summary.trim()}`).join("\n\n");
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
  const payload = {
    message: clip(input.message, 1_000),
    specialists: results.map(({ id, output }) => ({
      discipline: SPECIALIST_LABELS[id],
      summary: clip(output.summary, 500),
      recommendations: output.recommendations.slice(0, 3).map(({ target, recommendation, rationale, priority }) => ({
        target: clip(target, 80),
        priority,
        recommendation: clip(recommendation, 240),
        rationale: clip(rationale, 160),
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
 * Multi-agent Creative Director. Bounded: at most 5 specialist calls in parallel plus 1 synthesis call,
 * no recursion, no retries. Specialists only propose; the merged plan is a copy awaiting the filmmaker's Apply.
 */
export async function runDirector(
  input: DirectorRequest,
  deps: DirectorDeps,
  options: DirectorOptions = {},
): Promise<DirectorResponse> {
  const selected = selectSpecialists(input.message).slice(0, SPECIALIST_IDS.length);
  if (!selected.length) {
    const refined = await deps.refine({ plan: input.plan, messages: input.messages, message: input.message });
    return {
      mode: "refine",
      reply: refined.reply,
      specialists: [],
      failed: [],
      recommendations: [],
      conflicts: [],
      changeSummary: refined.changeSummary,
      plan: refined.plan,
      usage: [refined.usage],
    };
  }

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
