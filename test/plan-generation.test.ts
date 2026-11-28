import assert from "node:assert/strict";
import { test } from "node:test";
import type OpenAI from "openai";
import {
  type CallModel,
  createModelCaller,
  type ModelCall,
  ModelOutputError,
  type PrewarmCall,
} from "../src/lib/server/openai.ts";
import {
  OUTLINE_MAX_OUTPUT_TOKENS,
  type PlanInput,
  PlanGenerationError,
  runPlan,
  SCENE_MAX_OUTPUT_TOKENS,
  SCENE_TIMEOUT_MS,
} from "../src/lib/server/plan-generation.ts";
import { composeInstructions } from "../src/lib/server/prompts.ts";
import { MAX_PLAN_SCENES, type PlanOutline, planOutlineOutput, sceneShotsOutput, type ShotPlan } from "../src/lib/story-planning.ts";
import { sumUsage, type UsageRecord } from "../src/lib/usage.ts";
import { sectionJson, sectionList, sectionText, sectionTitles } from "./model-input.ts";

type Shot = ShotPlan["scenes"][number]["shots"][number];

/** The scene a plan_scene call writes; undefined for the outline call. */
function sceneNumber(call: ModelCall): number | undefined {
  const text = sectionText(call.input, "SCENE TO WRITE");
  return text === undefined ? undefined : Number(text.replace("Scene ", ""));
}

const INPUT: PlanInput = {
  story: "The Last Keeper",
  answers: [{ question: "Who is it about?", answer: "Mara, the last lighthouse keeper." }],
  collected: [{ label: "Tone", detail: "Bleak, then hopeful" }],
  context: { facts: [], unresolved: [] },
};

function outline(sceneCount = 3): PlanOutline {
  return {
    title: "The Last Keeper",
    logline: "A keeper relights a dying lighthouse.",
    intent: "Loneliness turning to resolve.",
    characters: [{ name: "Mara", role: "Keeper", look: "Oilskin coat", personality: "Stubborn", voice: "Low" }],
    locations: [{ name: "Lighthouse", description: "Storm-battered tower" }],
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      title: `Scene title ${index + 1}`,
      summary: `What happens in scene ${index + 1}.`,
      location: "Lighthouse",
      characters: ["Mara"],
      seconds: 30,
    })),
    reviewNotes: ["Assumption: it is winter."],
  };
}

const shot = (action: string, overrides: Partial<Shot> = {}): Shot => ({
  seconds: 4,
  framing: "Wide shot",
  camera: "Static",
  characters: ["Mara"],
  location: "Lighthouse",
  action,
  dialogue: [],
  emotion: "Dread",
  sound: "Wind",
  ...overrides,
});

const usage = (outputTokens: number, model = "gpt-test"): UsageRecord => ({
  step: "plan",
  model,
  inputTokens: 100,
  outputTokens,
  totalTokens: 100 + outputTokens,
});

type SceneHandler = (scene: number, call: ModelCall) => unknown | Promise<unknown>;

type FakeOptions = {
  outline?: unknown;
  scene?: SceneHandler;
  delay?: (scene: number) => number;
  prewarm?: (call: PrewarmCall) => Promise<UsageRecord>;
};

function fakeModel(options: FakeOptions = {}) {
  const calls: ModelCall[] = [];
  const prewarms: PrewarmCall[] = [];
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const callModel: CallModel = async (call) => {
    calls.push(call);
    const scene = sceneNumber(call);
    events.push(scene === undefined ? "outline" : `scene ${scene}`);
    if (scene === undefined) return { output: options.outline ?? outline(), usage: usage(500) };
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const wait = options.delay?.(scene) ?? 5;
      await new Promise((resolve) => setTimeout(resolve, wait));
      const output = options.scene ? await options.scene(scene, call) : { shots: [shot(`Shot of scene ${scene}`)] };
      return { output, usage: usage(200 + scene) };
    } finally {
      inFlight -= 1;
    }
  };
  const { prewarm } = options;
  if (prewarm) {
    callModel.prewarm = (call) => {
      prewarms.push(call);
      events.push("prewarm");
      return prewarm(call);
    };
  }
  return {
    callModel,
    calls,
    prewarms,
    events,
    get maxInFlight() {
      return maxInFlight;
    },
    sceneCalls: () => calls.filter((call) => sceneNumber(call) !== undefined),
  };
}

const never = (call: ModelCall) =>
  new Promise((_, reject) => {
    if (call.signal.aborted) return reject(call.signal.reason);
    call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
  });

test("one outline call, then one call per scene, all scene calls in parallel", async () => {
  const fake = fakeModel({ outline: outline(4) });
  await runPlan(INPUT, fake.callModel);
  assert.equal(fake.calls.length, 5);
  assert.equal(fake.maxInFlight, 4);
  const [first, ...scenes] = fake.calls;
  assert.equal(first.schema, planOutlineOutput);
  assert.equal(first.instructions, composeInstructions("plan_outline", "short_film"));
  assert.equal(first.maxOutputTokens, OUTLINE_MAX_OUTPUT_TOKENS);
  assert.deepEqual(sectionTitles(first.input), ["STORY", "ANSWERS", "COLLECTED"]);
  assert.equal(sectionText(first.input, "STORY"), INPUT.story);
  assert.equal(sectionText(first.input, "ANSWERS"), "Q1: Who is it about?\nA1: Mara, the last lighthouse keeper.");
  assert.deepEqual(sectionList(first.input, "COLLECTED"), ["Tone: Bleak, then hopeful"]);
  for (const call of scenes) {
    assert.equal(call.schema, sceneShotsOutput);
    assert.equal(call.instructions, composeInstructions("plan_scene", "short_film"));
    assert.equal(call.maxOutputTokens, SCENE_MAX_OUTPUT_TOKENS);
    assert.equal(call.step, "plan");
  }
});

test("each scene call gets the binding inputs, the full outline and its scene number", async () => {
  const fake = fakeModel();
  await runPlan(INPUT, fake.callModel);
  const calls = fake.sceneCalls();
  assert.deepEqual(calls.map(sceneNumber), [1, 2, 3]);
  for (const { input } of calls) {
    assert.deepEqual(sectionTitles(input), ["STORY", "COLLECTED", "OUTLINE (JSON)", "SCENE TO WRITE"]);
    assert.equal(sectionText(input, "STORY"), INPUT.story);
    assert.deepEqual(sectionList(input, "COLLECTED"), ["Tone: Bleak, then hopeful"]);
    const payload = { outline: sectionJson<ReturnType<typeof outline> & { scenes: { scene: number }[] }>(input, "OUTLINE (JSON)")! };
    assert.equal(payload.outline.title, "The Last Keeper");
    assert.equal(payload.outline.logline, outline().logline);
    assert.equal(payload.outline.intent, outline().intent);
    assert.deepEqual(payload.outline.characters, outline().characters);
    assert.deepEqual(payload.outline.locations, outline().locations);
    assert.deepEqual(payload.outline.scenes[1], {
      scene: 2,
      title: "Scene title 2",
      summary: "What happens in scene 2.",
      location: "Lighthouse",
      characters: ["Mara"],
      seconds: 30,
    });
    assert.equal(payload.outline.scenes.length, 3);
    assert.ok(!("reviewNotes" in payload.outline));
  }
});

test("the plan is assembled in outline order even when scenes finish out of order", async () => {
  const fake = fakeModel({
    delay: (scene) => (4 - scene) * 10,
    scene: (scene) => ({ shots: [shot(`Scene ${scene} A`), shot(`Scene ${scene} B`, { seconds: 5 })] }),
  });
  const { plan } = await runPlan(INPUT, fake.callModel);
  const expected = outline();
  assert.equal(plan.title, expected.title);
  assert.equal(plan.logline, expected.logline);
  assert.equal(plan.intent, expected.intent);
  assert.deepEqual(plan.characters, expected.characters);
  assert.deepEqual(plan.locations, expected.locations);
  assert.deepEqual(plan.reviewNotes, expected.reviewNotes);
  assert.deepEqual(
    plan.scenes.map(({ title }) => title),
    ["Scene title 1", "Scene title 2", "Scene title 3"],
  );
  assert.deepEqual(
    plan.scenes.map(({ shots }) => shots.map(({ action }) => action)),
    [
      ["Scene 1 A", "Scene 1 B"],
      ["Scene 2 A", "Scene 2 B"],
      ["Scene 3 A", "Scene 3 B"],
    ],
  );
  assert.deepEqual(Object.keys(plan).sort(), ["characters", "intent", "locations", "logline", "reviewNotes", "scenes", "title"]);
});

test("usage is one plan record summing every call", async () => {
  const fake = fakeModel();
  const { usage: total } = await runPlan(INPUT, fake.callModel);
  assert.deepEqual(total, {
    step: "plan",
    model: "gpt-test",
    inputTokens: 400,
    outputTokens: 500 + 201 + 202 + 203,
    totalTokens: 400 + 500 + 201 + 202 + 203,
  });
});

test("sumUsage adds tokens and names each distinct model once", () => {
  assert.deepEqual(sumUsage("plan", [usage(1, "a"), usage(2, "a"), usage(3, "b")]), {
    step: "plan",
    model: "a, b",
    inputTokens: 300,
    outputTokens: 6,
    totalTokens: 306,
  });
  assert.deepEqual(sumUsage("plan", []), { step: "plan", model: "", inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test("an outline with no scenes or more than the maximum is rejected before any scene call", async () => {
  for (const count of [0, MAX_PLAN_SCENES + 1]) {
    const fake = fakeModel({ outline: outline(count) });
    await assert.rejects(
      runPlan(INPUT, fake.callModel),
      (error: unknown) => error instanceof PlanGenerationError && error.failure === "outline",
      `${count} scenes`,
    );
    assert.equal(fake.calls.length, 1, `${count} scenes`);
  }
  const fake = fakeModel({ outline: outline(MAX_PLAN_SCENES) });
  const { plan } = await runPlan(INPUT, fake.callModel);
  assert.equal(plan.scenes.length, MAX_PLAN_SCENES);
});

test("an outline that fails the schema is a model output error", async () => {
  const fake = fakeModel({ outline: { title: "Only a title" } });
  await assert.rejects(runPlan(INPUT, fake.callModel), ModelOutputError);
  assert.equal(fake.calls.length, 1);
});

test("all-or-nothing: one failed scene fails the plan and aborts the other scene calls", async () => {
  const failure = new Error("scene 2 failed");
  const aborted: number[] = [];
  const fake = fakeModel({
    delay: () => 0,
    scene: (scene, call) => {
      if (scene === 2) throw failure;
      return never(call).catch((reason: unknown) => {
        aborted.push(scene);
        throw reason;
      });
    },
  });
  await assert.rejects(runPlan(INPUT, fake.callModel), (error: unknown) => error === failure);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(aborted.sort(), [1, 3]);
  assert.ok(fake.sceneCalls().every((call) => call.signal.aborted));
});

test("a scene without shots, invalid shots or an invalid assembled plan fails the plan", async () => {
  const empty = fakeModel({ scene: (scene) => ({ shots: scene === 3 ? [] : [shot("Fine")] }) });
  await assert.rejects(
    runPlan(INPUT, empty.callModel),
    (error: unknown) => error instanceof PlanGenerationError && error.failure === "scene",
  );
  const malformed = fakeModel({ scene: () => ({ shots: [{ action: "No other fields" }] }) });
  await assert.rejects(runPlan(INPUT, malformed.callModel), ModelOutputError);
  const badDialogue = fakeModel({
    scene: () => ({ shots: [shot("Talks", { dialogue: [{ speaker: "Mara", line: "  ", delivery: "" }] })] }),
  });
  await assert.rejects(
    runPlan(INPUT, badDialogue.callModel),
    (error: unknown) => error instanceof PlanGenerationError && error.failure === "invalid_plan",
  );
  const badSeconds = fakeModel({ scene: () => ({ shots: [shot("Zero", { seconds: 0 })] }) });
  await assert.rejects(
    runPlan(INPUT, badSeconds.callModel),
    (error: unknown) => error instanceof PlanGenerationError && error.failure === "invalid_plan",
  );
});

test("per-call deadlines abort a hung outline or scene call", async () => {
  const hungOutline: CallModel = (call) => never(call) as ReturnType<CallModel>;
  const started = Date.now();
  await assert.rejects(runPlan(INPUT, hungOutline, { outlineTimeoutMs: 20 }), { name: "TimeoutError" });
  assert.ok(Date.now() - started < 1_000);

  const fake = fakeModel({ scene: (scene, call) => (scene === 2 ? never(call) : { shots: [shot("Fine")] }) });
  await assert.rejects(runPlan(INPUT, fake.callModel, { sceneTimeoutMs: 30 }), { name: "TimeoutError" });
  assert.ok(fake.sceneCalls()[1].signal.aborted);
});

test("a deadline settles the call even when the model caller ignores its signal", async () => {
  const ignoring: CallModel = () => new Promise(() => {});
  await assert.rejects(runPlan(INPUT, ignoring, { outlineTimeoutMs: 20 }), { name: "TimeoutError" });
});

test("the request's own abort signal cancels the scene calls", async () => {
  const controller = new AbortController();
  const fake = fakeModel({
    scene: (scene, call) => {
      if (scene === 1) controller.abort(new Error("client went away"));
      return never(call);
    },
  });
  await assert.rejects(runPlan(INPUT, fake.callModel, { signal: controller.signal }), /client went away/);
  assert.ok(fake.sceneCalls().every((call) => call.signal.aborted));
});

// --- Prompt cache prewarm for the shared scene prefix ---

const LONG_INPUT: PlanInput = {
  ...INPUT,
  story: `The Last Keeper. ${"Mara climbs the tower every night to keep the lamp burning while the storm rises. ".repeat(60)}`,
};

const prewarmUsage: UsageRecord = { step: "plan", model: "gpt-test", inputTokens: 1_500, outputTokens: 0, totalTokens: 1_500 };

const fullInput = (call: ModelCall) => `${call.cachedPrefix ?? ""}${call.input}`;

test("a large shared prefix is prewarmed once before the scene calls, and every scene call reads it", async () => {
  const fake = fakeModel({ prewarm: async () => prewarmUsage });
  const { usage: total } = await runPlan(LONG_INPUT, fake.callModel);

  assert.deepEqual(fake.events.slice(0, 2), ["outline", "prewarm"]);
  assert.equal(fake.prewarms.length, 1);
  const [prewarm] = fake.prewarms;
  const scenes = fake.sceneCalls();
  assert.equal(scenes.length, 3);
  assert.deepEqual(sectionTitles(prewarm.cachedPrefix), ["STORY", "COLLECTED", "OUTLINE (JSON)"]);
  assert.ok(prewarm.cachedPrefix.endsWith("\n"));
  assert.equal(prewarm.stage, "plan_scene");
  for (const call of scenes) {
    assert.equal(call.cachedPrefix, prewarm.cachedPrefix);
    assert.deepEqual(sectionTitles(call.input), ["SCENE TO WRITE"]);
    assert.deepEqual(sectionTitles(fullInput(call)), ["STORY", "COLLECTED", "OUTLINE (JSON)", "SCENE TO WRITE"]);
    assert.equal(call.instructions, prewarm.instructions);
    assert.equal(call.schema, prewarm.schema);
    assert.equal(call.maxOutputTokens, prewarm.maxOutputTokens);
    assert.equal(call.step, prewarm.step);
    assert.equal(call.stage, "plan_scene");
  }
  assert.equal(total.inputTokens, 400 + 1_500, "the prewarm's usage is part of the plan's");
});

test("a failed, empty or hung prewarm leaves the plan uncached and it still succeeds", async (t) => {
  const warned: unknown[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warned.push(args));
  const failures: Record<string, (call: PrewarmCall) => Promise<UsageRecord>> = {
    rejected: async () => {
      throw new Error("prewarm unavailable");
    },
    "nothing written": async () => {
      throw new ModelOutputError("Prompt cache not written", prewarmUsage, "no_cache_write");
    },
    hung: () => new Promise(() => {}),
  };
  for (const [name, prewarm] of Object.entries(failures)) {
    const fake = fakeModel({ prewarm });
    const started = Date.now();
    const { plan, usage: total } = await runPlan(LONG_INPUT, fake.callModel, { prewarmTimeoutMs: 20 });
    assert.ok(Date.now() - started < 1_000, name);
    assert.equal(plan.scenes.length, 3, name);
    assert.equal(fake.prewarms.length, 1, name);
    for (const call of fake.sceneCalls()) {
      assert.equal(call.cachedPrefix, undefined, name);
      assert.deepEqual(sectionTitles(call.input), ["STORY", "COLLECTED", "OUTLINE (JSON)", "SCENE TO WRITE"], name);
      assert.equal(call.input, fullInput(call), name);
    }
    assert.equal(total.inputTokens, name === "nothing written" ? 1_900 : 400, name);
  }
  assert.equal(warned.length, 3);
  assert.ok(!JSON.stringify(warned).includes("Mara climbs"));
});

test("a small prefix or a single scene sends no prewarm", async () => {
  const small = fakeModel({ prewarm: async () => prewarmUsage });
  await runPlan(INPUT, small.callModel);
  assert.equal(small.prewarms.length, 0);
  assert.ok(small.sceneCalls().every((call) => call.cachedPrefix === undefined));

  const single = fakeModel({ outline: outline(1), prewarm: async () => prewarmUsage });
  await runPlan(LONG_INPUT, single.callModel);
  assert.equal(single.prewarms.length, 0);
  assert.equal(single.sceneCalls()[0].cachedPrefix, undefined);
});

test("the prewarm comes out of the scene budget, so the plan keeps its time limit", async () => {
  const fake = fakeModel({
    prewarm: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return prewarmUsage;
    },
  });
  await runPlan(LONG_INPUT, fake.callModel);
  assert.equal(fake.prewarms[0].timeoutMs, 15_000);
  for (const call of fake.sceneCalls()) {
    assert.ok(call.timeoutMs !== undefined && call.timeoutMs <= SCENE_TIMEOUT_MS - 30, String(call.timeoutMs));
  }
});

test("over the wire: the prewarm and every scene request share one prefix part, breakpoint and settings", async (t) => {
  t.mock.method(console, "info", () => {});
  const bodies: Record<string, unknown>[] = [];
  const respond = (output: unknown, details: Record<string, number>) => ({
    status: "completed",
    incomplete_details: null,
    model: "gpt-test",
    output_parsed: output,
    usage: { input_tokens: 2_000, input_tokens_details: details, output_tokens: 10, total_tokens: 2_010 },
  });
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>) => {
        bodies.push(body);
        const options = body.prompt_cache_options as { prewarm?: boolean };
        if (options.prewarm) return respond(null, { cached_tokens: 0, cache_write_tokens: 1_800 });
        if (typeof body.input === "string") return respond(outline(), { cached_tokens: 0, cache_write_tokens: 0 });
        return respond({ shots: [shot("Fine")] }, { cached_tokens: 1_800, cache_write_tokens: 0 });
      },
    },
  };
  const { usage: total } = await runPlan(LONG_INPUT, createModelCaller(client as unknown as OpenAI));

  const [outlineBody, prewarmBody, ...sceneBodies] = bodies;
  assert.equal(sceneBodies.length, 3);
  assert.deepEqual(outlineBody.prompt_cache_options, { mode: "explicit" });
  assert.equal((outlineBody.text as { verbosity?: string }).verbosity, "medium");
  assert.ok(bodies.every((body) => !("prompt_cache_key" in body) && !("reasoning" in body)));

  const breakpoint = { mode: "explicit", ttl: "30m" };
  type Message = { role: string; content: { type: string; text: string; prompt_cache_breakpoint?: unknown }[] }[];
  const prefixPart = (prewarmBody.input as Message)[0].content[0];
  assert.deepEqual(prewarmBody.prompt_cache_options, { mode: "explicit", ttl: "30m", prewarm: true });
  assert.deepEqual(prewarmBody.input, [{ role: "user", content: [prefixPart] }]);
  assert.equal(prefixPart.type, "input_text");
  assert.deepEqual(prefixPart.prompt_cache_breakpoint, breakpoint);
  assert.deepEqual(sectionTitles(prefixPart.text), ["STORY", "COLLECTED", "OUTLINE (JSON)"]);
  sceneBodies.forEach((body, index) => {
    const { input, prompt_cache_options, ...rest } = body;
    const { input: _prewarmInput, prompt_cache_options: _prewarmOptions, ...prewarmRest } = prewarmBody;
    assert.deepEqual(rest, prewarmRest, "model, instructions, text format, verbosity and caps match the prewarm");
    assert.deepEqual(prompt_cache_options, { mode: "explicit", ttl: "30m" });
    const [message] = input as Message;
    assert.equal(message.role, "user");
    assert.deepEqual(message.content[0], prefixPart);
    assert.deepEqual(message.content.slice(1), [{ type: "input_text", text: `## SCENE TO WRITE\nScene ${index + 1}` }]);
  });
  assert.equal((prewarmBody.text as { verbosity?: string }).verbosity, "low");
  assert.equal(total.cachedTokens, 3 * 1_800);
  assert.equal(total.inputTokens, 5 * 2_000);
});
