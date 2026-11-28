import { DEFAULT_FORMAT, type FilmFormat } from "@/lib/formats";
import type { CollectedItem, InterviewExchange } from "@/lib/interview";
import {
  answersSection,
  collectedSection,
  contextFacts,
  jsonSection,
  listSection,
  memorySection,
  removedSection,
  SECTION,
  section,
  sections,
  splitDirections,
  textSection,
} from "@/lib/server/memory-view";
import {
  type CallModel,
  deadline,
  type ModelCall,
  ModelOutputError,
  PREWARM_TIMEOUT_MS,
  prewarmPrefix,
  untilAborted,
} from "@/lib/server/openai";
import { findPlanProblem } from "@/lib/server/plan-validation";
import { composeInstructions } from "@/lib/server/prompts";
import { MAX_CONTEXT_FACTS, type StoryContext, toCollected } from "@/lib/story-context";
import {
  MAX_PLAN_SCENES,
  type PlanOutline,
  planOutlineOutput,
  type ShotPlan,
  sceneShotsOutput,
} from "@/lib/story-planning";
import { sumUsage, type UsageRecord } from "@/lib/usage";

export type PlanInput = {
  story: string;
  answers: InterviewExchange[];
  collected?: CollectedItem[];
  context?: StoryContext;
  format?: FilmFormat;
};

export type PlanOptions = {
  signal?: AbortSignal;
  outlineTimeoutMs?: number;
  sceneTimeoutMs?: number;
  prewarmTimeoutMs?: number;
};

export type PlanResult = { plan: ShotPlan; usage: UsageRecord };

export type PlanFailure = "outline" | "scene" | "invalid_plan";

/** The model answered, but its outline, a scene or the assembled plan isn't usable. */
export class PlanGenerationError extends Error {
  constructor(
    readonly failure: PlanFailure,
    readonly detail: string,
  ) {
    super(`Plan generation failed (${failure}): ${detail}`);
    this.name = "PlanGenerationError";
  }
}

export const OUTLINE_MAX_OUTPUT_TOKENS = 3_000;
export const SCENE_MAX_OUTPUT_TOKENS = 4_000;
export const OUTLINE_TIMEOUT_MS = 75_000;
export const SCENE_TIMEOUT_MS = 100_000;

type Shots = ShotPlan["scenes"][number]["shots"];

/** Everything a scene call needs to keep names and continuity consistent with the rest of the film. */
function outlineBrief(outline: PlanOutline) {
  return {
    title: outline.title,
    logline: outline.logline,
    intent: outline.intent,
    characters: outline.characters,
    locations: outline.locations,
    scenes: outline.scenes.map(({ title, summary, location, characters, seconds }, index) => ({
      scene: index + 1,
      title,
      summary,
      location,
      characters,
      seconds,
    })),
  };
}

/** Collected details the context doesn't already state: clients send collected as the flattened context. */
export function collectedBeyondContext(collected: readonly CollectedItem[], context: StoryContext | undefined): CollectedItem[] {
  if (!context?.facts.length) return [...collected];
  const key = ({ label, detail }: CollectedItem) => `${label.trim()}\n${detail.trim()}`;
  const stated = new Set(toCollected(context, MAX_CONTEXT_FACTS).map(key));
  return collected.filter((item) => !stated.has(key(item)));
}

/** Text the filmmaker sent after discovery: it reaches no context fact, so the scene calls need it verbatim. */
export function extraDirections(answers: readonly InterviewExchange[]): string[] {
  return splitDirections(answers).directions;
}

async function writeOutline(input: PlanInput, format: FilmFormat, callModel: CallModel, options: PlanOptions) {
  const signal = deadline(options.signal, options.outlineTimeoutMs ?? OUTLINE_TIMEOUT_MS);
  const { story, context } = input;
  const { answers, directions } = splitDirections(input.answers);
  const result = await untilAborted(
    callModel({
      step: "plan",
      stage: "plan_outline",
      instructions: composeInstructions("plan_outline", format),
      input: sections(
        textSection(SECTION.story, story),
        answersSection(answers),
        listSection(SECTION.directions, directions),
        context ? memorySection(contextFacts(context)) : "",
        removedSection(context?.removed),
        listSection(SECTION.openQuestions, context?.unresolved ?? []),
        collectedSection(collectedBeyondContext(input.collected ?? [], context)),
      ),
      schema: planOutlineOutput,
      maxOutputTokens: OUTLINE_MAX_OUTPUT_TOKENS,
      signal,
    }),
    signal,
  );
  const parsed = planOutlineOutput.safeParse(result.output);
  if (!parsed.success) throw new ModelOutputError("Invalid plan outline", result.usage);
  const sceneCount = parsed.data.scenes.length;
  if (sceneCount === 0 || sceneCount > MAX_PLAN_SCENES) {
    throw new PlanGenerationError("outline", `The outline has ${sceneCount} scenes.`);
  }
  return { outline: parsed.data, usage: result.usage };
}

type SceneCall = Omit<ModelCall, "input" | "cachedPrefix" | "signal" | "timeoutMs">;

/** `shared` is the prefix every scene call sends first; `cached` when a prewarm wrote it to the prompt cache. */
async function writeScene(
  sceneNumber: number,
  call: SceneCall,
  shared: { prefix: string; cached: boolean },
  callModel: CallModel,
  timeoutMs: number,
  batch: AbortSignal,
): Promise<{ shots: Shots; usage: UsageRecord }> {
  const signal = deadline(batch, timeoutMs);
  const own = section(SECTION.sceneToWrite, `Scene ${sceneNumber}`);
  const input = shared.cached ? { cachedPrefix: shared.prefix, input: own } : { input: `${shared.prefix}${own}` };
  const result = await untilAborted(callModel({ ...call, ...input, signal, timeoutMs }), signal);
  const parsed = sceneShotsOutput.safeParse(result.output);
  if (!parsed.success) throw new ModelOutputError(`Invalid shots for scene ${sceneNumber}`, result.usage);
  if (!parsed.data.shots.length) throw new PlanGenerationError("scene", `Scene ${sceneNumber} has no shots.`);
  return { shots: parsed.data.shots, usage: result.usage };
}

/**
 * Writes a shot plan in parts so no single model call has to produce the whole plan: one outline call, then one call
 * per scene, all in parallel, reading their shared prefix from the prompt cache when a prewarm could write it.
 * All-or-nothing: the first failed part aborts the others and fails the plan; a failed prewarm only turns caching off.
 * Bounded at 2 + MAX_PLAN_SCENES calls. Returns one usage record summing every call, the prewarm included.
 */
export async function runPlan(input: PlanInput, callModel: CallModel, options: PlanOptions = {}): Promise<PlanResult> {
  const format = input.format ?? DEFAULT_FORMAT;
  const { outline, usage: outlineUsage } = await writeOutline(input, format, callModel, options);

  const batch = new AbortController();
  const parent = options.signal ? AbortSignal.any([options.signal, batch.signal]) : batch.signal;
  const scene: SceneCall = {
    step: "plan",
    stage: "plan_scene",
    instructions: composeInstructions("plan_scene", format),
    schema: sceneShotsOutput,
    maxOutputTokens: SCENE_MAX_OUTPUT_TOKENS,
  };
  const prefix = `${sections(
    textSection(SECTION.story, input.story),
    collectedSection(input.collected ?? []),
    listSection(SECTION.directions, extraDirections(input.answers)),
    jsonSection(SECTION.outline, outlineBrief(outline)),
  )}\n`;
  const prewarmStarted = Date.now();
  const prewarmTimeoutMs = options.prewarmTimeoutMs ?? PREWARM_TIMEOUT_MS;
  const prewarm = await prewarmPrefix(
    callModel,
    { ...scene, cachedPrefix: prefix, signal: deadline(parent, prewarmTimeoutMs), timeoutMs: prewarmTimeoutMs },
    outline.scenes.length,
  );
  // The prewarm runs inside the scene budget so the plan still fits the route's maxDuration.
  const sceneTimeoutMs = Math.max(1, (options.sceneTimeoutMs ?? SCENE_TIMEOUT_MS) - (Date.now() - prewarmStarted));
  const shared = { prefix, cached: prewarm.cachedPrefix !== undefined };
  const scenes = await Promise.all(
    outline.scenes.map((_, index) =>
      writeScene(index + 1, scene, shared, callModel, sceneTimeoutMs, parent).catch((error: unknown) => {
        batch.abort(error);
        throw error;
      }),
    ),
  );

  const plan: ShotPlan = {
    title: outline.title,
    logline: outline.logline,
    intent: outline.intent,
    characters: outline.characters,
    locations: outline.locations,
    scenes: outline.scenes.map(({ title }, index) => ({ title, shots: scenes[index].shots })),
    reviewNotes: outline.reviewNotes,
  };
  const problem = findPlanProblem(plan);
  if (problem) throw new PlanGenerationError("invalid_plan", problem);
  const prewarmUsage = prewarm.usage ? [prewarm.usage] : [];
  return { plan, usage: sumUsage("plan", [outlineUsage, ...prewarmUsage, ...scenes.map(({ usage }) => usage)]) };
}
