import assert from "node:assert/strict";
import { test } from "node:test";
import { type CallModel, type ModelCall, ModelOutputError } from "../src/lib/server/openai.ts";
import {
  OUTLINE_MAX_OUTPUT_TOKENS,
  type PlanInput,
  PlanGenerationError,
  runPlan,
  SCENE_MAX_OUTPUT_TOKENS,
} from "../src/lib/server/plan-generation.ts";
import { composeInstructions } from "../src/lib/server/prompts.ts";
import { MAX_PLAN_SCENES, type PlanOutline, planOutlineOutput, sceneShotsOutput, type ShotPlan } from "../src/lib/story-planning.ts";
import { sumUsage, type UsageRecord } from "../src/lib/usage.ts";

type Shot = ShotPlan["scenes"][number]["shots"][number];

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

function fakeModel(options: { outline?: unknown; scene?: SceneHandler; delay?: (scene: number) => number } = {}) {
  const calls: ModelCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const callModel: CallModel = async (call) => {
    calls.push(call);
    const payload = JSON.parse(call.input) as { scene?: number };
    if (payload.scene === undefined) return { output: options.outline ?? outline(), usage: usage(500) };
    const scene = payload.scene;
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
  return {
    callModel,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    sceneCalls: () => calls.filter((call) => JSON.parse(call.input).scene !== undefined),
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
  assert.deepEqual(JSON.parse(first.input), {
    story: INPUT.story,
    answers: INPUT.answers,
    collected: INPUT.collected,
    context: INPUT.context,
  });
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
  const payloads = fake.sceneCalls().map((call) => JSON.parse(call.input));
  assert.deepEqual(
    payloads.map(({ scene }) => scene),
    [1, 2, 3],
  );
  for (const payload of payloads) {
    assert.equal(payload.story, INPUT.story);
    assert.deepEqual(payload.answers, INPUT.answers);
    assert.deepEqual(payload.collected, INPUT.collected);
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
