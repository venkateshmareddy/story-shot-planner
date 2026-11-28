import assert from "node:assert/strict";
import { test } from "node:test";
import type OpenAI from "openai";
import { z } from "zod";
import { MODEL_SETTINGS, type ModelStage, stageForStep } from "../src/lib/server/model-settings.ts";
import {
  type CallModel,
  createModelCaller,
  type ModelCall,
  ModelOutputError,
  type PrewarmCall,
  prewarmPrefix,
  worthPrewarming,
} from "../src/lib/server/openai.ts";
import { runRefine } from "../src/lib/server/refine.ts";
import { editPlanOutput, type ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord } from "../src/lib/usage.ts";

const LOW: readonly ModelStage[] = [
  "interview",
  "plan_scene",
  "edit_scene",
  "story-analyst",
  "cinematography-director",
  "sound-director",
  "editing-director",
  "continuity-reviewer",
  "ideas",
  "digest",
  "originality_review",
  "originality_compare",
];
const MEDIUM: readonly ModelStage[] = ["draft", "plan_outline", "edit_plan", "synthesis", "image-analysis"];

const schema = z.object({ ok: z.boolean() });
const signal = () => new AbortController().signal;

function recordingClient(details: Record<string, number> = { cached_tokens: 0, cache_write_tokens: 0 }) {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return {
          status: "completed",
          incomplete_details: null,
          model: "gpt-test",
          output_parsed: { ok: true },
          usage: { input_tokens: 3_000, input_tokens_details: details, output_tokens: 5, total_tokens: 3_005 },
        };
      },
    },
  };
  return { callModel: createModelCaller(client as unknown as OpenAI), bodies };
}

const call = (overrides: Partial<ModelCall> = {}): ModelCall => ({
  step: "plan",
  instructions: "Instructions.",
  input: "## SCENE TO WRITE\nScene 1",
  schema,
  maxOutputTokens: 100,
  signal: signal(),
  ...overrides,
});

const verbosityOf = (body: Record<string, unknown>) => (body.text as { verbosity?: string }).verbosity;

test("the settings table: low for structured or short output, medium where the filmmaker reads the prose", () => {
  assert.deepEqual(Object.keys(MODEL_SETTINGS).sort(), [...LOW, ...MEDIUM].sort());
  for (const stage of LOW) assert.equal(MODEL_SETTINGS[stage].verbosity, "low", stage);
  for (const stage of MEDIUM) assert.equal(MODEL_SETTINGS[stage].verbosity, "medium", stage);
});

test("a call without a stage runs as its step's stage; plan, refine and originality span stages and name theirs", () => {
  assert.equal(stageForStep("orchestrator"), "synthesis");
  assert.equal(stageForStep("interview"), "interview");
  assert.equal(stageForStep("draft"), "draft");
  assert.equal(stageForStep("sound-director"), "sound-director");
  assert.equal(stageForStep("plan"), null);
  assert.equal(stageForStep("refine"), null);
  assert.equal(stageForStep("transcribe"), null);
  assert.equal(stageForStep("originality"), null);
  assert.equal(stageForStep("originality-lookup"), null);
});

test("every stage gets its verbosity, prompt caching off, and no cache key, retention or reasoning", async (t) => {
  t.mock.method(console, "info", () => {});
  const { callModel, bodies } = recordingClient();
  for (const stage of [...LOW, ...MEDIUM]) await callModel(call({ stage }));
  await callModel(call({ step: "orchestrator" }));
  await callModel(call({ step: "continuity-reviewer" }));
  await callModel(call({ step: "plan" }));

  [...LOW, ...MEDIUM].forEach((stage, index) => assert.equal(verbosityOf(bodies[index]), MODEL_SETTINGS[stage].verbosity, stage));
  const [synthesis, continuity, unnamed] = bodies.slice(-3);
  assert.equal(verbosityOf(synthesis), "medium");
  assert.equal(verbosityOf(continuity), "low");
  assert.ok(!("verbosity" in (unnamed.text as object)), "a step spanning stages keeps the API default");
  for (const body of bodies) {
    assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
    assert.equal(typeof body.input, "string");
    for (const key of ["prompt_cache_key", "prompt_cache_retention", "reasoning"]) assert.ok(!(key in body), key);
  }
});

test("a cached prefix is its own content part ending at a 30m breakpoint, then the call's own input", async (t) => {
  t.mock.method(console, "info", () => {});
  const { callModel, bodies } = recordingClient({ cached_tokens: 2_400, cache_write_tokens: 0 });
  const { usage } = await callModel(call({ stage: "plan_scene", cachedPrefix: "## STORY\nShared\n" }));
  assert.deepEqual(bodies[0].input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "## STORY\nShared\n", prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" } },
        { type: "input_text", text: "## SCENE TO WRITE\nScene 1" },
      ],
    },
  ]);
  assert.deepEqual(bodies[0].prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.ok(!("prompt_cache_key" in bodies[0]));
  assert.equal(usage.cachedTokens, 2_400);
});

test("prewarm sends only the prefix part with prewarm: true and logs the cache write without content", async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => logged.push(args));
  const { callModel, bodies } = recordingClient({ cached_tokens: 0, cache_write_tokens: 2_600 });
  const prewarm: PrewarmCall = { ...call({ stage: "plan_scene" }), cachedPrefix: "## STORY\nSECRET STORY\n" };
  assert.ok(callModel.prewarm);
  const usage = await callModel.prewarm({ ...prewarm, timeoutMs: 15_000 });
  await callModel(call({ stage: "plan_scene", cachedPrefix: prewarm.cachedPrefix }));

  const [warm, scene] = bodies;
  assert.deepEqual(warm.prompt_cache_options, { mode: "explicit", ttl: "30m", prewarm: true });
  assert.deepEqual(warm.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: prewarm.cachedPrefix, prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" } },
      ],
    },
  ]);
  for (const key of ["model", "instructions", "text", "max_output_tokens", "store"]) {
    assert.deepEqual(warm[key], scene[key], key);
  }
  assert.equal(verbosityOf(warm), "low");
  assert.equal(usage.inputTokens, 3_000);
  const [label, line] = logged[0] as [string, { prewarm: boolean; cacheWriteTokens: number; stage: string }];
  assert.equal(label, "Model usage");
  assert.equal(line.prewarm, true);
  assert.equal(line.cacheWriteTokens, 2_600);
  assert.equal(line.stage, "plan_scene");
  assert.ok(!JSON.stringify(logged).includes("SECRET STORY"));
});

test("a prewarm that neither wrote nor found the prefix rejects with its usage", async (t) => {
  t.mock.method(console, "info", () => {});
  const { callModel } = recordingClient();
  assert.ok(callModel.prewarm);
  await assert.rejects(
    callModel.prewarm({ ...call(), cachedPrefix: "Prefix" }),
    (error: unknown) =>
      error instanceof ModelOutputError && error.reason === "no_cache_write" && error.usage.inputTokens === 3_000,
  );
  const found = recordingClient({ cached_tokens: 2_800, cache_write_tokens: 0 });
  assert.ok(found.callModel.prewarm);
  assert.equal((await found.callModel.prewarm({ ...call(), cachedPrefix: "Prefix" })).cachedTokens, 2_800);
});

test("prewarming needs two readers and an estimated 1,280 tokens (chars / 4) of instructions plus prefix", () => {
  const chars = 1_280 * 4;
  assert.equal(worthPrewarming("i".repeat(1_000), "p".repeat(chars - 1_000), 2), true);
  assert.equal(worthPrewarming("i".repeat(1_000), "p".repeat(chars - 1_001), 2), false);
  assert.equal(worthPrewarming("", "p".repeat(chars * 4), 1), false);
  assert.equal(worthPrewarming("", "p".repeat(chars), 20), true);
});

const USAGE: UsageRecord = { step: "plan", model: "gpt-test", inputTokens: 1_500, outputTokens: 0, totalTokens: 1_500 };
const LARGE: PrewarmCall = { ...call(), cachedPrefix: "p".repeat(6_000), signal: signal() };

test("prewarmPrefix returns the prefix only after a successful prewarm and never throws", async (t) => {
  const warned: unknown[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warned.push(args));
  const withPrewarm = (prewarm: NonNullable<CallModel["prewarm"]>): CallModel =>
    Object.assign(async () => ({ output: null, usage: USAGE }), { prewarm });

  assert.deepEqual(await prewarmPrefix(async () => ({ output: null, usage: USAGE }), LARGE, 3), {});
  let sent = 0;
  const counting = withPrewarm(async () => {
    sent += 1;
    return USAGE;
  });
  assert.deepEqual(await prewarmPrefix(counting, { ...LARGE, cachedPrefix: "short" }, 3), {});
  assert.deepEqual(await prewarmPrefix(counting, LARGE, 1), {});
  assert.equal(sent, 0);
  assert.deepEqual(await prewarmPrefix(counting, LARGE, 3), { cachedPrefix: LARGE.cachedPrefix, usage: USAGE });
  assert.equal(sent, 1);

  const failing = withPrewarm(async () => {
    throw Object.assign(new Error("boom"), { status: 400 });
  });
  assert.deepEqual(await prewarmPrefix(failing, LARGE, 3), {});
  const empty = withPrewarm(async () => {
    throw new ModelOutputError("Prompt cache not written", USAGE, "no_cache_write");
  });
  assert.deepEqual(await prewarmPrefix(empty, LARGE, 3), { usage: USAGE });
  const hung = withPrewarm(() => new Promise(() => {}));
  assert.deepEqual(await prewarmPrefix(hung, { ...LARGE, signal: AbortSignal.timeout(20) }, 3), {});

  assert.equal(warned.length, 3);
  assert.deepEqual((warned[1] as [string, Record<string, unknown>])[1], {
    step: "plan",
    stage: null,
    error: "ModelOutputError",
    outputTokens: 0,
    reason: "no_cache_write",
  });
  assert.ok(!JSON.stringify(warned).includes("ppppp"));
});

function smallPlan(): ShotPlan {
  const shot = {
    seconds: 4,
    framing: "Wide",
    camera: "Static",
    characters: ["Mara"],
    location: "Lighthouse",
    action: "Mara climbs.",
    dialogue: [],
    emotion: "Calm",
    sound: "Wind",
  };
  return {
    title: "The Last Keeper",
    logline: "A keeper relights a dying lighthouse.",
    intent: "Resolve.",
    characters: [{ name: "Mara", role: "Keeper", look: "Oilskin", personality: "Stubborn", voice: "Low" }],
    locations: [{ name: "Lighthouse", description: "Tower" }],
    scenes: [
      { title: "Night", shots: [shot] },
      { title: "Dawn", shots: [shot] },
    ],
    reviewNotes: [],
  };
}

test("refine names its stages: edit_plan for the decide call, edit_scene for each scene call", async () => {
  const calls: ModelCall[] = [];
  const usage: UsageRecord = { step: "refine", model: "fake", inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const plan = smallPlan();
  const callModel: CallModel = async (modelCall) => {
    calls.push(modelCall);
    if (modelCall.schema !== editPlanOutput) return { output: { ...plan.scenes[1], title: "Rainy dawn" }, usage };
    const output = {
      reply: "I'll make scene 2 rainy. Press Apply to update your board.",
      changeSummary: ["Scene 2 is rainy"],
      renames: [],
      title: null,
      logline: null,
      intent: null,
      characters: null,
      locations: null,
      reviewNotes: null,
      sceneChanges: [{ action: "rewrite", index: 1, instruction: "Add rain" }],
    };
    return { output, usage };
  };
  await runRefine(callModel, { plan, messages: [], message: "Make scene 2 rainy" });
  assert.deepEqual(
    calls.map(({ step, stage }) => [step, stage]),
    [
      ["refine", "edit_plan"],
      ["refine", "edit_scene"],
    ],
  );
});
