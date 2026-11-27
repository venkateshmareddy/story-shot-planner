import { DEFAULT_FORMAT, type FilmFormat } from "@/lib/formats";
import type { CollectedItem, InterviewExchange } from "@/lib/interview";
import { type CallModel, deadline, ModelOutputError, untilAborted } from "@/lib/server/openai";
import { findPlanProblem } from "@/lib/server/plan-validation";
import { composeInstructions } from "@/lib/server/prompts";
import type { StoryContext } from "@/lib/story-context";
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

async function writeOutline(input: PlanInput, format: FilmFormat, callModel: CallModel, options: PlanOptions) {
  const signal = deadline(options.signal, options.outlineTimeoutMs ?? OUTLINE_TIMEOUT_MS);
  const { story, answers, collected, context } = input;
  const result = await untilAborted(
    callModel({
      step: "plan",
      instructions: composeInstructions("plan_outline", format),
      input: JSON.stringify({ story, answers, collected, context }),
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

type SceneInput = { story: string; answers: InterviewExchange[]; collected: CollectedItem[]; outline: ReturnType<typeof outlineBrief> };

async function writeScene(
  sceneNumber: number,
  shared: SceneInput,
  format: FilmFormat,
  callModel: CallModel,
  options: PlanOptions,
  batch: AbortSignal,
): Promise<{ shots: Shots; usage: UsageRecord }> {
  const timeoutMs = options.sceneTimeoutMs ?? SCENE_TIMEOUT_MS;
  const signal = deadline(batch, timeoutMs);
  const result = await untilAborted(
    callModel({
      step: "plan",
      instructions: composeInstructions("plan_scene", format),
      input: JSON.stringify({ ...shared, scene: sceneNumber }),
      schema: sceneShotsOutput,
      maxOutputTokens: SCENE_MAX_OUTPUT_TOKENS,
      signal,
      timeoutMs,
    }),
    signal,
  );
  const parsed = sceneShotsOutput.safeParse(result.output);
  if (!parsed.success) throw new ModelOutputError(`Invalid shots for scene ${sceneNumber}`, result.usage);
  if (!parsed.data.shots.length) throw new PlanGenerationError("scene", `Scene ${sceneNumber} has no shots.`);
  return { shots: parsed.data.shots, usage: result.usage };
}

/**
 * Writes a shot plan in parts so no single model call has to produce the whole plan: one outline call, then one call
 * per scene, all in parallel. All-or-nothing: the first failed part aborts the others and fails the plan.
 * Bounded at 1 + MAX_PLAN_SCENES calls. Returns one usage record summing every call.
 */
export async function runPlan(input: PlanInput, callModel: CallModel, options: PlanOptions = {}): Promise<PlanResult> {
  const format = input.format ?? DEFAULT_FORMAT;
  const { outline, usage: outlineUsage } = await writeOutline(input, format, callModel, options);

  const batch = new AbortController();
  const parent = options.signal ? AbortSignal.any([options.signal, batch.signal]) : batch.signal;
  const shared: SceneInput = {
    story: input.story,
    answers: input.answers,
    collected: input.collected ?? [],
    outline: outlineBrief(outline),
  };
  const scenes = await Promise.all(
    outline.scenes.map((_, index) =>
      writeScene(index + 1, shared, format, callModel, options, parent).catch((error: unknown) => {
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
  return { plan, usage: sumUsage("plan", [outlineUsage, ...scenes.map(({ usage }) => usage)]) };
}
