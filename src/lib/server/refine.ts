import { isDeepStrictEqual } from "node:util";
import { findTargetScenes, isSceneStructureEdit } from "@/lib/agents/scope";
import { clip } from "@/lib/agents/shared";
import { DEFAULT_FORMAT, type FilmFormat } from "@/lib/formats";
import { applyRefinePatch, applyRenames, isUsableScene, renameNameColumns, validRenames } from "@/lib/refine-patch";
import {
  chatSection,
  decisionsSection,
  jsonSection,
  oneLine,
  SECTION,
  section,
  sections,
  textSection,
} from "@/lib/server/memory-view";
import {
  type CallModel,
  deadline,
  type ModelErrorMetadata,
  ModelOutputError,
  modelErrorMetadata,
  untilAborted,
} from "@/lib/server/openai";
import { composeInstructions } from "@/lib/server/prompts";
import {
  type EditPlan,
  editPlanOutput,
  MAX_PLAN_SCENES,
  type RefinePatch,
  type RefineRequest,
  type Rename,
  type ShotPlan,
  sceneRewriteOutput,
} from "@/lib/story-planning";
import type { UsageRecord } from "@/lib/usage";

type Scene = ShotPlan["scenes"][number];
type SceneChange = EditPlan["sceneChanges"][number];

export type RefineResult = {
  reply: string;
  changeSummary: string[];
  /** The proposed plan, or the plan as sent when nothing changes. */
  plan: ShotPlan;
  /** false when the request was answered without a change, so there is nothing to Apply. */
  changed: boolean;
  /** One record per model call. */
  usage: UsageRecord[];
};

/** Metadata-only diagnosis of one failed call. Never carries story text. */
export type RefineFailure = ModelErrorMetadata & { part: "decide" | "scene"; scene?: number; maxOutputTokens: number };

export type RefineOptions = {
  signal?: AbortSignal;
  decideTimeoutMs?: number;
  sceneTimeoutMs?: number;
  /** Called once for the call that failed (not for the scene calls it then cancelled). */
  onFailure?: (failure: RefineFailure) => void;
};

export type RefineRejection =
  | "scene_index"
  | "too_many_scenes"
  | "unusable_plan"
  | "invalid_patch"
  | "no_effective_change";

/** The model's edit can't be applied to the plan as sent. */
export class InvalidRefinedPlanError extends Error {
  constructor(readonly reason: RefineRejection = "invalid_patch") {
    super(`The refined plan could not be applied (${reason})`);
    this.name = "InvalidRefinedPlanError";
  }
}

export const INVALID_REFINED_PLAN_MESSAGE = "This change couldn’t be applied to your plan. Try rephrasing your request.";

export const EDIT_PLAN_MAX_OUTPUT_TOKENS = 3_000;
export const EDIT_PLAN_TIMEOUT_MS = 75_000;
export const EDIT_SCENE_MAX_OUTPUT_TOKENS = 4_000;
export const EDIT_SCENE_TIMEOUT_MS = 100_000;
const NEIGHBOUR_TEXT_CHARACTERS = 200;
const MAX_REFERENCED_SCENES = 3;

/** The filmmaker's imported story and verdicts on earlier proposals: stable across a session, so sent early. */
function history({ decisions, source }: Pick<RefineRequest, "decisions" | "source">) {
  return [textSection(SECTION.source, source), decisionsSection(decisions)];
}

function hintsSection(message: string, sceneCount: number) {
  const named = findTargetScenes(message, sceneCount);
  return section(SECTION.hints, [
    `namedScenes: ${named.length ? named.map((index) => `Scene ${index + 1} (index ${index})`).join(", ") : "none"}`,
    `changesSceneList: ${isSceneStructureEdit(message)}`,
  ]);
}

async function decide(
  callModel: CallModel,
  input: RefineRequest,
  format: FilmFormat,
  options: RefineOptions,
): Promise<{ edit: EditPlan; usage: UsageRecord }> {
  const timeoutMs = options.decideTimeoutMs ?? EDIT_PLAN_TIMEOUT_MS;
  const signal = deadline(options.signal, timeoutMs);
  const { plan, messages, message } = input;
  const modelInput = sections(
    jsonSection(SECTION.plan, plan),
    section(
      SECTION.sceneIndexes,
      plan.scenes.map(({ title }, index) => `${index} = Scene ${index + 1}: ${oneLine(title)}`),
    ),
    ...history(input),
    chatSection(messages),
    hintsSection(message, plan.scenes.length),
    textSection(SECTION.message, message),
  );
  try {
    const { output, usage } = await untilAborted(
      callModel({
        step: "refine",
        stage: "edit_plan",
        instructions: composeInstructions("edit_plan", format),
        input: modelInput,
        schema: editPlanOutput,
        maxOutputTokens: EDIT_PLAN_MAX_OUTPUT_TOKENS,
        signal,
        timeoutMs,
      }),
      signal,
    );
    const parsed = editPlanOutput.safeParse(output);
    if (!parsed.success || !parsed.data.reply.trim()) {
      throw new ModelOutputError("Invalid edit plan", usage, "invalid_output");
    }
    return { edit: parsed.data, usage };
  } catch (error) {
    options.onFailure?.({ part: "decide", ...modelErrorMetadata(error), maxOutputTokens: EDIT_PLAN_MAX_OUTPUT_TOKENS });
    throw error;
  }
}

/** Rejects an edit plan before any scene call is paid for. Indices refer to the plan as sent. */
function checkSceneChanges(sceneCount: number, changes: readonly SceneChange[]) {
  if (changes.filter(({ action }) => action !== "remove").length > MAX_PLAN_SCENES) {
    throw new InvalidRefinedPlanError("too_many_scenes");
  }
  const touched = new Set<number>();
  for (const { action, index } of changes) {
    if (action === "insert_after") {
      if (index < -1 || index >= sceneCount) throw new InvalidRefinedPlanError("scene_index");
      continue;
    }
    if (index < 0 || index >= sceneCount || touched.has(index)) throw new InvalidRefinedPlanError("scene_index");
    touched.add(index);
  }
}

function nonEmpty<T>(list: T[] | null): T[] | null {
  return list?.length ? list : null;
}

type SceneContext = {
  format: FilmFormat;
  overview: Pick<ShotPlan, "title" | "logline" | "intent" | "characters" | "locations">;
  renames: Rename[];
  /** The plan as sent, with the renames applied. */
  renamed: ShotPlan;
  changes: readonly SceneChange[];
  request: Pick<RefineRequest, "message" | "decisions" | "source">;
};

function neighbour(context: SceneContext, side: "Before" | "After", index: number) {
  const scene = context.renamed.scenes[index];
  if (!scene) return `${side}: none`;
  const change = context.changes.find((item) => item.index === index && item.action !== "insert_after");
  const parts = [
    `${side}: Scene ${index + 1} · ${oneLine(scene.title)}`,
    `opens: ${clip(scene.shots[0]?.action ?? "", NEIGHBOUR_TEXT_CHARACTERS)}`,
    `ends: ${clip(scene.shots.at(-1)?.action ?? "", NEIGHBOUR_TEXT_CHARACTERS)}`,
  ];
  if (change) parts.push(`change: ${change.action === "remove" ? "removed" : `rewritten: ${clip(change.instruction, 300)}`}`);
  return parts.join(" | ");
}

/** Shared by every scene call of one edit first, then this scene's own part, instruction last. */
function sceneInput(context: SceneContext, change: SceneChange) {
  const { renamed, request } = context;
  const rewrite = change.action === "rewrite";
  const before = rewrite ? change.index - 1 : change.index;
  const referenced = findTargetScenes(change.instruction, renamed.scenes.length)
    .filter((index) => !rewrite || index !== change.index)
    .slice(0, MAX_REFERENCED_SCENES);
  const follows = change.index + 1;
  return sections(
    jsonSection(SECTION.overview, context.overview),
    section(
      SECTION.renames,
      context.renames.map(({ from, to }) => `- ${oneLine(from)} → ${oneLine(to)}`),
    ),
    ...history(request),
    textSection(SECTION.message, request.message),
    rewrite
      ? jsonSection(SECTION.scene, { number: change.index + 1, ...renamed.scenes[change.index] })
      : section(SECTION.newScene, follows === 0 ? "Goes first, before Scene 1." : `Goes after Scene ${follows}.`),
    referenced.length
      ? jsonSection(
          SECTION.referenced,
          referenced.map((index) => ({ number: index + 1, ...renamed.scenes[index] })),
        )
      : "",
    section(SECTION.neighbours, [
      neighbour(context, "Before", before),
      neighbour(context, "After", before + (rewrite ? 2 : 1)),
    ]),
    section(SECTION.instruction, oneLine(change.instruction)),
  );
}

async function writeScene(
  callModel: CallModel,
  context: SceneContext,
  change: SceneChange,
  options: RefineOptions,
  batch: AbortSignal,
  cancelled: AbortSignal,
): Promise<{ scene: Scene; usage: UsageRecord }> {
  const timeoutMs = options.sceneTimeoutMs ?? EDIT_SCENE_TIMEOUT_MS;
  const signal = deadline(batch, timeoutMs);
  try {
    const result = await untilAborted(
      callModel({
        step: "refine",
        stage: "edit_scene",
        instructions: composeInstructions("edit_scene", context.format),
        input: sceneInput(context, change),
        schema: sceneRewriteOutput,
        maxOutputTokens: EDIT_SCENE_MAX_OUTPUT_TOKENS,
        signal,
        timeoutMs,
      }),
      signal,
    );
    const parsed = sceneRewriteOutput.safeParse(result.output);
    if (!parsed.success) throw new ModelOutputError("Invalid scene", result.usage, "invalid_output");
    if (!isUsableScene(parsed.data)) throw new ModelOutputError("Unusable scene", result.usage, "unusable_scene");
    return { scene: parsed.data, usage: result.usage };
  } catch (error) {
    if (!cancelled.aborted) {
      options.onFailure?.({
        part: "scene",
        scene: change.index + 1,
        ...modelErrorMetadata(error),
        maxOutputTokens: EDIT_SCENE_MAX_OUTPUT_TOKENS,
      });
    }
    throw error;
  }
}

/** All-or-nothing: the first failed scene cancels the rest. Results follow `changes` order (null for remove). */
async function writeScenes(
  callModel: CallModel,
  context: SceneContext,
  options: RefineOptions,
): Promise<{ scenes: (Scene | null)[]; usage: UsageRecord[] }> {
  const batch = new AbortController();
  const parent = options.signal ? AbortSignal.any([options.signal, batch.signal]) : batch.signal;
  const results = await Promise.all(
    context.changes.map((change) =>
      change.action === "remove"
        ? null
        : writeScene(callModel, context, change, options, parent, batch.signal).catch((error: unknown) => {
            batch.abort(error);
            throw error;
          }),
    ),
  );
  return {
    scenes: results.map((result) => result?.scene ?? null),
    usage: results.flatMap((result) => (result ? [result.usage] : [])),
  };
}

function toSceneEdits(changes: readonly SceneChange[], scenes: readonly (Scene | null)[]): RefinePatch["sceneEdits"] {
  return changes.map(({ action, index }, position) =>
    action === "remove"
      ? { action: "remove", index, scene: null }
      : { action: action === "rewrite" ? "replace" : "insert_after", index, scene: scenes[position] },
  );
}

/**
 * A chat edit in parts, so no call's output grows with the plan: (1) one call decides exactly what changes and writes
 * the confirmation; (2) name changes are applied in code; (3) each scene to rewrite or insert gets its own call, all
 * in parallel. Bounded at 1 + MAX_PLAN_SCENES calls. A question or a request that needs no change makes one call and
 * returns the plan as sent with changed false.
 */
export async function runRefine(
  callModel: CallModel,
  input: RefineRequest,
  options: RefineOptions = {},
): Promise<RefineResult> {
  const format = input.format ?? DEFAULT_FORMAT;
  const { edit, usage: decideUsage } = await decide(callModel, input, format, options);
  checkSceneChanges(input.plan.scenes.length, edit.sceneChanges);

  const renames = validRenames(input.plan, edit.renames).map(({ from, to }) => ({ from, to }));
  const renamed = applyRenames(input.plan, renames);
  const overviewPatch: RefinePatch = {
    reply: edit.reply,
    changeSummary: edit.changeSummary,
    title: edit.title,
    logline: edit.logline,
    intent: edit.intent,
    characters: nonEmpty(edit.characters),
    locations: nonEmpty(edit.locations),
    reviewNotes: edit.reviewNotes,
    sceneEdits: [],
  };
  const withOverview = applyRefinePatch(renamed, overviewPatch);
  if (!withOverview) throw new InvalidRefinedPlanError("unusable_plan");
  const overview = renameNameColumns(withOverview, renames);

  const written = await writeScenes(
    callModel,
    {
      format,
      overview: {
        title: overview.title,
        logline: overview.logline,
        intent: overview.intent,
        characters: overview.characters,
        locations: overview.locations,
      },
      renames,
      renamed,
      changes: edit.sceneChanges,
      request: { message: input.message, decisions: input.decisions, source: input.source },
    },
    options,
  );
  const usage = [decideUsage, ...written.usage];

  const assembled = applyRefinePatch(renamed, {
    ...overviewPatch,
    sceneEdits: toSceneEdits(edit.sceneChanges, written.scenes),
  });
  if (!assembled) throw new InvalidRefinedPlanError("invalid_patch");
  const plan = renameNameColumns(assembled, renames);
  const changed = !isDeepStrictEqual(plan, input.plan);
  if (!changed && (edit.renames.length || edit.sceneChanges.length)) {
    throw new InvalidRefinedPlanError("no_effective_change");
  }
  return {
    reply: edit.reply.trim(),
    changeSummary: changed ? edit.changeSummary : [],
    plan: changed ? plan : structuredClone(input.plan),
    changed,
    usage,
  };
}
