import assert from "node:assert/strict";
import { test } from "node:test";
import { type DirectorDeps, runDirector } from "../src/lib/agents/orchestrator.ts";
import { maxDuration as directorMaxDuration } from "../src/app/api/story/director/route.ts";
import { maxDuration as refineMaxDuration } from "../src/app/api/story/refine/route.ts";
import { type CallModel, type ModelCall, ModelOutputError } from "../src/lib/server/openai.ts";
import { composeInstructions } from "../src/lib/server/prompts.ts";
import {
  EDIT_PLAN_MAX_OUTPUT_TOKENS,
  EDIT_PLAN_TIMEOUT_MS,
  EDIT_SCENE_MAX_OUTPUT_TOKENS,
  EDIT_SCENE_TIMEOUT_MS,
  InvalidRefinedPlanError,
  type RefineFailure,
  type RefineOptions,
  runRefine,
} from "../src/lib/server/refine.ts";
import {
  type EditPlan,
  editPlanOutput,
  MAX_PLAN_SCENES,
  type RefineRequest,
  type ShotPlan,
  sceneRewriteOutput,
} from "../src/lib/story-planning.ts";
import type { UsageRecord } from "../src/lib/usage.ts";
import { sectionJson, sectionList, sectionText, sectionTitles } from "./model-input.ts";

type Scene = ShotPlan["scenes"][number];
type Shot = Scene["shots"][number];

const SHOTS_PER_SCENE = [11, 11, 11, 11, 11, 10];
const SCENE_TITLES = ["Storm", "The Keeper finds her", "Kitchen", "Radio call", "Lamp Room", "Dawn"];

function keeperShot(scene: number, shot: number): Shot {
  const speaking = shot % 3 === 0;
  return {
    seconds: 4,
    framing: shot % 2 ? "Close-up on the Keeper" : "Wide shot",
    camera: "Slow push in",
    characters: shot % 4 === 0 ? ["Keeper", "Girl"] : ["Keeper"],
    location: scene % 2 ? "Keeper's Room" : "Lamp Room",
    action: `The Keeper checks the lamp (${scene + 1}.${shot + 1}). The lonely lighthouse keeper sighs.`,
    dialogue: speaking ? [{ speaker: "Keeper", line: "Stay by the fire.", delivery: "Low" }] : [],
    emotion: "Wary",
    sound: "Wind and the Keeper's footsteps",
  };
}

function keeperPlan(): ShotPlan {
  return {
    title: "The Keeper",
    logline: "The lonely lighthouse keeper finds a girl on the rocks.",
    intent: "Trust grows in a storm.",
    characters: [
      { name: "Keeper", role: "the lonely lighthouse keeper", look: "Oilskin coat", personality: "Wary", voice: "Low" },
      { name: "Girl", role: "Castaway", look: "Wet dress", personality: "Bold", voice: "Bright" },
      { name: "Dispatcher", role: "Radio voice", look: "Unseen", personality: "Calm", voice: "Crackly" },
    ],
    locations: [
      { name: "Keeper's Room", description: "the Keeper's chair by the window" },
      { name: "Lamp Room", description: "Glass and brass" },
    ],
    scenes: SCENE_TITLES.map((title, scene) => ({
      title,
      shots: Array.from({ length: SHOTS_PER_SCENE[scene] }, (_, shot) => keeperShot(scene, shot)),
    })),
    reviewNotes: ["Suggestion: keep the Keeper quiet."],
  };
}

const allShots = (plan: ShotPlan) => plan.scenes.flatMap(({ shots }) => shots);

function editPlan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    reply: "I'll make that change. Press Apply to update your board.",
    changeSummary: [],
    renames: [],
    title: null,
    logline: null,
    intent: null,
    characters: null,
    locations: null,
    reviewNotes: null,
    sceneChanges: [],
    ...overrides,
  };
}

const newScene = (title: string, shots: Shot[] = [keeperShot(0, 0)]): Scene => ({ title, shots });

const usage = (outputTokens: number): UsageRecord => ({
  step: "refine",
  model: "fake",
  inputTokens: 1_000,
  outputTokens,
  totalTokens: 1_000 + outputTokens,
});

type SceneHandler = (payload: ScenePayload, call: ModelCall) => unknown | Promise<unknown>;

type ScenePayload = {
  overview: Pick<ShotPlan, "title" | "logline" | "intent" | "characters" | "locations">;
  renames: { from: string; to: string }[];
  scene: (Scene & { number: number }) | null;
  newSceneAfter?: number;
  referencedScenes: (Scene & { number: number })[];
  before: { number: number; title: string; opens: string; ends: string; change?: string } | null;
  after: { number: number; title: string; opens: string; ends: string; change?: string } | null;
  instruction: string;
  message: string;
  decisions: string[];
  source?: string;
};

type Neighbour = NonNullable<ScenePayload["before"]>;

/** "Before: Scene 2 · Title | opens: … | ends: … | change: …" or "Before: none". */
function neighbourOf(line: string | undefined): Neighbour | null {
  assert.ok(line, "neighbour line missing");
  if (/^(?:Before|After): none$/.test(line)) return null;
  const [head, opens, ends, change] = line.split(" | ");
  const match = /^(?:Before|After): Scene (\d+) · (.*)$/.exec(head);
  assert.ok(match, line);
  return {
    number: Number(match[1]),
    title: match[2],
    opens: opens.replace(/^opens: /, ""),
    ends: ends.replace(/^ends: /, ""),
    ...(change ? { change: change.replace(/^change: /, "") } : {}),
  };
}

/** An edit_scene input read back into the fields the scene call is given. */
function scenePayload(input: string): ScenePayload {
  const neighbours = (sectionText(input, "NEIGHBOURS") ?? "").split("\n");
  const newScene = sectionText(input, "NEW SCENE");
  const source = sectionText(input, "STORY SOURCE");
  return {
    overview: sectionJson<ScenePayload["overview"]>(input, "OVERVIEW (JSON)")!,
    renames: sectionList(input, "RENAMES").map((line) => {
      const [from, to] = line.split(" → ");
      return { from, to };
    }),
    scene: sectionJson<Scene & { number: number }>(input, "SCENE (JSON)") ?? null,
    ...(newScene === undefined
      ? {}
      : { newSceneAfter: newScene.startsWith("Goes first") ? 0 : Number(/Scene (\d+)/.exec(newScene)?.[1]) }),
    referencedScenes: sectionJson<(Scene & { number: number })[]>(input, "REFERENCED SCENES (JSON)") ?? [],
    before: neighbourOf(neighbours.find((line) => line.startsWith("Before:"))),
    after: neighbourOf(neighbours.find((line) => line.startsWith("After:"))),
    instruction: sectionText(input, "INSTRUCTION") ?? "",
    message: sectionText(input, "MESSAGE") ?? "",
    decisions: sectionList(input, "DECISIONS"),
    ...(source === undefined ? {} : { source }),
  };
}

/** 0-based scene indexes the edit_plan HINTS name. */
const namedScenes = (input: string) =>
  Array.from((sectionText(input, "HINTS") ?? "").matchAll(/\(index (\d+)\)/g), (match) => Number(match[1]));

function fakeModel(decision: EditPlan | ((call: ModelCall) => unknown), onScene: SceneHandler = () => newScene("Rewritten")) {
  const calls: ModelCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const callModel: CallModel = async (call) => {
    calls.push(call);
    if (call.schema === editPlanOutput) {
      const output = typeof decision === "function" ? decision(call) : decision;
      return { output, usage: usage(300) };
    }
    assert.equal(call.schema, sceneRewriteOutput);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const output = await onScene(scenePayload(call.input), call);
      return { output, usage: usage(1_500) };
    } finally {
      inFlight -= 1;
    }
  };
  return {
    callModel,
    calls,
    sceneCalls: () => calls.filter(({ schema }) => schema === sceneRewriteOutput),
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const refineInput = (message: string, extra: Partial<RefineRequest> = {}): RefineRequest => ({
  plan: keeperPlan(),
  messages: [{ role: "user", text: "Earlier note" }],
  message,
  ...extra,
});

const director = (model: ReturnType<typeof fakeModel>, options: RefineOptions = {}): DirectorDeps => ({
  callModel: async () => {
    throw new Error("No specialist expected");
  },
  refine: (input) => runRefine(model.callModel, input, options),
});

const DECISIONS: RefineRequest["decisions"] = [{ status: "rejected", request: "Add a dog", changes: ["S02: a dog"] }];

// --- Step 1: decide ---

test("a rename is one decision call and is applied in code to every shot", async () => {
  const model = fakeModel(
    editPlan({
      reply: "I'll rename the Keeper to Aswin everywhere: the Characters table, every shot and every line of dialogue. Press Apply to update your board.",
      changeSummary: ["Characters: Keeper is now Aswin", "All 65 shots: Keeper renamed to Aswin"],
      renames: [{ from: "Keeper", to: "Aswin" }],
    }),
  );
  const result = await runRefine(
    model.callModel,
    refineInput("the keeper name was aswin", { decisions: DECISIONS, source: "Imported story:\nText" }),
  );

  assert.equal(model.calls.length, 1);
  assert.equal(model.sceneCalls().length, 0);
  const [call] = model.calls;
  assert.equal(call.step, "refine");
  assert.equal(call.schema, editPlanOutput);
  assert.equal(call.maxOutputTokens, EDIT_PLAN_MAX_OUTPUT_TOKENS);
  assert.equal(call.timeoutMs, EDIT_PLAN_TIMEOUT_MS);
  assert.equal(call.instructions, composeInstructions("edit_plan", "short_film"));
  const { input } = call;
  assert.deepEqual(sectionTitles(input), [
    "PLAN (JSON)",
    "SCENE INDEXES",
    "STORY SOURCE",
    "DECISIONS",
    "RECENT CHAT",
    "HINTS",
    "MESSAGE",
  ]);
  assert.deepEqual(sectionJson(input, "PLAN (JSON)"), keeperPlan());
  const indexes = sectionText(input, "SCENE INDEXES")?.split("\n") ?? [];
  assert.equal(indexes[1], "1 = Scene 2: The Keeper finds her");
  assert.equal(indexes.length, 6);
  assert.equal(sectionText(input, "HINTS"), "namedScenes: none\nchangesSceneList: false");
  assert.equal(sectionText(input, "MESSAGE"), "the keeper name was aswin");
  assert.equal(sectionText(input, "RECENT CHAT"), "Filmmaker: Earlier note");
  assert.deepEqual(sectionList(input, "DECISIONS"), ["Discarded: Add a dog → S02: a dog"]);
  assert.equal(sectionText(input, "STORY SOURCE"), "Imported story:\nText");

  assert.equal(result.changed, true);
  assert.match(result.reply, /Press Apply/);
  assert.deepEqual(result.changeSummary, ["Characters: Keeper is now Aswin", "All 65 shots: Keeper renamed to Aswin"]);
  assert.deepEqual(result.usage, [usage(300)]);
  const shots = allShots(result.plan);
  assert.equal(shots.length, 65);
  assert.ok(shots.every(({ characters }) => characters[0] === "Aswin" && !characters.includes("Keeper")));
  assert.ok(shots.every(({ action }) => action.startsWith("Aswin checks the lamp") && action.endsWith("The lonely lighthouse keeper sighs.")));
  assert.ok(shots.every(({ sound }) => sound === "Wind and Aswin's footsteps"));
  assert.ok(shots.every(({ framing }) => !framing.includes("Keeper")));
  assert.ok(shots.flatMap(({ dialogue }) => dialogue).every(({ speaker }) => speaker === "Aswin"));
  assert.ok(shots.every(({ location }) => location === "Aswin's Room" || location === "Lamp Room"));
  assert.deepEqual(result.plan.characters.map(({ name }) => name), ["Aswin", "Girl", "Dispatcher"]);
  assert.deepEqual(result.plan.locations.map(({ name }) => name), ["Aswin's Room", "Lamp Room"]);
  assert.equal(result.plan.logline, keeperPlan().logline);
  assert.equal(result.plan.title, "The Keeper");
});

test("the director turns a rename into a proposal with one usage record", async () => {
  const model = fakeModel(editPlan({ renames: [{ from: "Keeper", to: "Aswin" }], changeSummary: ["Keeper is now Aswin"] }));
  const result = await runDirector({ plan: keeperPlan(), messages: [], message: "the keeper name was aswin" }, director(model));
  assert.equal(result.mode, "refine");
  assert.ok(result.plan);
  assert.equal(result.plan.characters[0].name, "Aswin");
  assert.deepEqual(result.changeSummary, ["Keeper is now Aswin"]);
  assert.deepEqual(result.usage, [usage(300)]);
});

test("a question gets an answer and no proposal: plan null, nothing to Apply", async () => {
  const model = fakeModel(editPlan({ reply: "Scene 3 is 44 seconds long.", changeSummary: ["ignored"] }));
  const result = await runRefine(model.callModel, refineInput("How long is scene 3?"));
  assert.equal(result.changed, false);
  assert.deepEqual(result.plan, keeperPlan());
  assert.deepEqual(result.changeSummary, []);
  assert.equal(model.calls.length, 1);
  assert.deepEqual(namedScenes(model.calls[0].input), [2]);

  const team = await runDirector({ plan: keeperPlan(), messages: [], message: "How long is scene 3?" }, director(fakeModel(editPlan({ reply: "44 seconds." }))));
  assert.equal(team.reply, "44 seconds.");
  assert.equal(team.plan, null);
  assert.deepEqual(team.changeSummary, []);
  assert.equal(team.usage.length, 1);
});

test("overview fields change without any scene call", async () => {
  const model = fakeModel(editPlan({ title: "Aswin's Light", intent: "  ", reviewNotes: [] }));
  const result = await runRefine(model.callModel, refineInput("Call the film Aswin's Light and drop the notes"));
  assert.equal(model.sceneCalls().length, 0);
  assert.equal(result.plan.title, "Aswin's Light");
  assert.equal(result.plan.intent, keeperPlan().intent);
  assert.deepEqual(result.plan.reviewNotes, []);
  assert.deepEqual(result.plan.scenes, keeperPlan().scenes);
});

// --- Step 2: scene rewrites in parallel ---

test("a whole-film change rewrites every scene in parallel, one call each, with continuity context", async () => {
  const sceneChanges = SCENE_TITLES.map((_, index) => ({ action: "rewrite" as const, index, instruction: `Darker scene ${index + 1}` }));
  const model = fakeModel(editPlan({ sceneChanges, changeSummary: ["All scenes: darker"] }), async (payload) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return newScene(`${payload.scene?.title} (dark)`, payload.scene?.shots.slice(0, 2));
  });
  const result = await runRefine(model.callModel, refineInput("Make the whole film darker", { decisions: DECISIONS, source: "Story" }));

  const scenes = model.sceneCalls();
  assert.equal(scenes.length, 6);
  assert.equal(model.maxInFlight, 6);
  for (const call of scenes) {
    assert.equal(call.step, "refine");
    assert.equal(call.maxOutputTokens, EDIT_SCENE_MAX_OUTPUT_TOKENS);
    assert.equal(call.timeoutMs, EDIT_SCENE_TIMEOUT_MS);
    assert.equal(call.instructions, composeInstructions("edit_scene", "short_film"));
  }
  const second = scenePayload(scenes[1].input);
  assert.equal(second.scene?.number, 2);
  assert.deepEqual(second.scene?.shots, keeperPlan().scenes[1].shots);
  assert.equal(second.instruction, "Darker scene 2");
  assert.equal(second.message, "Make the whole film darker");
  assert.deepEqual(second.decisions, ["Discarded: Add a dog → S02: a dog"]);
  assert.equal(second.source, "Story");
  assert.deepEqual(second.overview.characters, keeperPlan().characters);
  assert.equal(second.before?.number, 1);
  assert.equal(second.before?.title, "Storm");
  assert.match(second.before?.ends ?? "", /\(1\.11\)/);
  assert.equal(second.before?.change, "rewritten: Darker scene 1");
  assert.equal(second.after?.number, 3);
  assert.match(second.after?.opens ?? "", /\(3\.1\)/);
  const first = scenePayload(scenes[0].input);
  assert.equal(first.before, null);
  assert.equal(scenePayload(scenes[5].input).after, null);

  assert.deepEqual(result.plan.scenes.map(({ title }) => title), SCENE_TITLES.map((title) => `${title} (dark)`));
  assert.equal(result.usage.length, 7);
  assert.deepEqual(result.usage[0], usage(300));
  assert.ok(result.usage.slice(1).every((record) => record.outputTokens === 1_500));
});

test("only the named scene is rewritten; the others stay byte-identical", async () => {
  const model = fakeModel(
    editPlan({ sceneChanges: [{ action: "rewrite", index: 1, instruction: "Add rain" }] }),
    (payload) => ({ ...payload.scene, title: "Rain" }),
  );
  const result = await runRefine(model.callModel, refineInput("Make scene 2 rainy"));
  assert.deepEqual(namedScenes(model.calls[0].input), [1]);
  assert.equal(model.sceneCalls().length, 1);
  assert.equal(result.plan.scenes[1].title, "Rain");
  for (const index of [0, 2, 3, 4, 5]) assert.deepEqual(result.plan.scenes[index], keeperPlan().scenes[index]);
  assert.equal(result.usage.length, 2);
});

test("scene calls see the renamed scene and overview, and old names they write back are fixed", async () => {
  const model = fakeModel(
    editPlan({
      renames: [{ from: "Keeper", to: "Aswin" }],
      characters: [
        { name: "Keeper", role: "Keeper of the light", look: "Oilskin coat", personality: "Wary", voice: "Low" },
        { name: "Girl", role: "Castaway", look: "Wet dress", personality: "Bold", voice: "Bright" },
        { name: "Dispatcher", role: "Radio voice", look: "Unseen", personality: "Calm", voice: "Crackly" },
        { name: "Fisher", role: "Rescuer", look: "Yellow hat", personality: "Brisk", voice: "Loud" },
      ],
      sceneChanges: [{ action: "rewrite", index: 5, instruction: "A fisher arrives" }],
    }),
    (payload) =>
      newScene("Dawn, the fisher", [
        { ...payload.scene!.shots[0], characters: ["Keeper", "Fisher"], dialogue: [{ speaker: "KEEPER", line: "Go.", delivery: "Low" }] },
      ]),
  );
  const result = await runRefine(model.callModel, refineInput("Rename the keeper to Aswin and add a fisher at dawn"));
  const payload = scenePayload(model.sceneCalls()[0].input);
  assert.deepEqual(payload.renames, [{ from: "Keeper", to: "Aswin" }]);
  assert.deepEqual(payload.overview.characters.map(({ name }) => name), ["Aswin", "Girl", "Dispatcher", "Fisher"]);
  assert.ok(payload.scene?.shots.every(({ characters }) => characters[0] === "Aswin"));
  assert.ok(payload.before?.ends.startsWith("Aswin checks"));

  assert.deepEqual(result.plan.characters.map(({ name }) => name), ["Aswin", "Girl", "Dispatcher", "Fisher"]);
  assert.deepEqual(result.plan.scenes[5].shots[0].characters, ["Aswin", "Fisher"]);
  assert.equal(result.plan.scenes[5].shots[0].dialogue[0].speaker, "Aswin");
  assert.ok(allShots(result.plan).every(({ characters }) => !characters.includes("Keeper")));
});

test("insert and remove: new scenes go in place, removed ones go, and an instruction can bring a scene along", async () => {
  const model = fakeModel(
    editPlan({
      sceneChanges: [
        { action: "insert_after", index: -1, instruction: "A cold open on the rocks" },
        { action: "remove", index: 2, instruction: "" },
        { action: "insert_after", index: 4, instruction: "Scene 3, moved here unchanged" },
      ],
    }),
    (payload) =>
      payload.referencedScenes.length ? { ...payload.referencedScenes[0], title: "Kitchen (moved)" } : newScene("Cold open"),
  );
  const result = await runRefine(model.callModel, refineInput("Open on the rocks and move the kitchen scene before dawn"));
  assert.equal(model.sceneCalls().length, 2);
  assert.deepEqual(result.plan.scenes.map(({ title }) => title), [
    "Cold open",
    "Storm",
    "The Keeper finds her",
    "Radio call",
    "Lamp Room",
    "Kitchen (moved)",
    "Dawn",
  ]);
  assert.deepEqual(result.plan.scenes[5].shots, keeperPlan().scenes[2].shots);

  const [open, moved] = model.sceneCalls().map((call) => scenePayload(call.input));
  assert.equal(open.scene, null);
  assert.equal(open.newSceneAfter, 0);
  assert.equal(open.before, null);
  assert.equal(open.after?.number, 1);
  assert.equal(moved.newSceneAfter, 5);
  assert.deepEqual(moved.referencedScenes.map(({ number }) => number), [3]);
  assert.equal(moved.before?.number, 5);
  assert.equal(moved.after?.number, 6);
  assert.equal(result.usage.length, 3);
});

// --- Rejections and failures ---

test("invalid scene indices are rejected before any scene call", async () => {
  const bad: EditPlan["sceneChanges"][] = [
    [{ action: "rewrite", index: 6, instruction: "x" }],
    [{ action: "rewrite", index: -1, instruction: "x" }],
    [{ action: "remove", index: 6, instruction: "" }],
    [{ action: "insert_after", index: -2, instruction: "x" }],
    [{ action: "insert_after", index: 6, instruction: "x" }],
    [
      { action: "rewrite", index: 1, instruction: "x" },
      { action: "remove", index: 1, instruction: "" },
    ],
  ];
  for (const sceneChanges of bad) {
    const model = fakeModel(editPlan({ sceneChanges }));
    await assert.rejects(
      runRefine(model.callModel, refineInput("Change it")),
      (error: unknown) => error instanceof InvalidRefinedPlanError && error.reason === "scene_index",
      JSON.stringify(sceneChanges),
    );
    assert.equal(model.sceneCalls().length, 0);
  }
  const fractional = fakeModel(editPlan({ sceneChanges: [{ action: "rewrite", index: 1.5, instruction: "x" }] }));
  await assert.rejects(runRefine(fractional.callModel, refineInput("Change it")), ModelOutputError);
  assert.equal(fractional.sceneCalls().length, 0);
});

test(`more than ${MAX_PLAN_SCENES} scene rewrites and inserts are rejected before any scene call`, async () => {
  const sceneChanges = Array.from({ length: MAX_PLAN_SCENES + 1 }, () => ({ action: "insert_after" as const, index: 0, instruction: "x" }));
  const model = fakeModel(editPlan({ sceneChanges }));
  await assert.rejects(
    runRefine(model.callModel, refineInput("Add lots of scenes")),
    (error: unknown) => error instanceof InvalidRefinedPlanError && error.reason === "too_many_scenes",
  );
  assert.equal(model.sceneCalls().length, 0);

  const atCap = fakeModel(editPlan({ sceneChanges: sceneChanges.slice(1) }));
  const result = await runRefine(atCap.callModel, refineInput("Add lots of scenes"));
  assert.equal(atCap.sceneCalls().length, MAX_PLAN_SCENES);
  assert.equal(result.plan.scenes.length, 6 + MAX_PLAN_SCENES);
});

test("removing every scene is rejected", async () => {
  const sceneChanges = SCENE_TITLES.map((_, index) => ({ action: "remove" as const, index, instruction: "" }));
  await assert.rejects(
    runRefine(fakeModel(editPlan({ sceneChanges })).callModel, refineInput("Delete everything")),
    (error: unknown) => error instanceof InvalidRefinedPlanError && error.reason === "invalid_patch",
  );
});

test("a rename that matches no name and nothing else to change is rejected, not confirmed", async () => {
  const model = fakeModel(editPlan({ renames: [{ from: "Lighthouse man", to: "Aswin" }] }));
  await assert.rejects(
    runRefine(model.callModel, refineInput("the keeper name was aswin")),
    (error: unknown) => error instanceof InvalidRefinedPlanError && error.reason === "no_effective_change",
  );
});

test("a failed scene call fails the whole edit, cancels the others and is logged once without story text", async () => {
  const failures: RefineFailure[] = [];
  const aborted: boolean[] = [];
  const sceneChanges = [0, 1, 2].map((index) => ({ action: "rewrite" as const, index, instruction: "x" }));
  const model = fakeModel(editPlan({ sceneChanges }), (payload, call) => {
    if (payload.scene?.number === 2) throw new ModelOutputError("Incomplete model result", usage(4_000), "max_output_tokens");
    return new Promise((_, reject) => {
      call.signal.addEventListener("abort", () => {
        aborted.push(true);
        reject(call.signal.reason);
      });
    });
  });
  await assert.rejects(
    runRefine(model.callModel, refineInput("Rewrite the first three scenes"), { onFailure: (failure) => failures.push(failure) }),
    (error: unknown) => error instanceof ModelOutputError && error.reason === "max_output_tokens",
  );
  assert.equal(aborted.length, 2);
  assert.deepEqual(failures, [
    {
      part: "scene",
      scene: 2,
      error: "ModelOutputError",
      reason: "max_output_tokens",
      outputTokens: 4_000,
      maxOutputTokens: EDIT_SCENE_MAX_OUTPUT_TOKENS,
    },
  ]);
  assert.ok(!JSON.stringify(failures).includes("Keeper"));
});

test("a scene without shots or with a bad duration fails the edit", async () => {
  for (const scene of [newScene("Empty", []), newScene("Zero", [{ ...keeperShot(0, 0), seconds: 0 }]), { title: "No shots key" }]) {
    const model = fakeModel(editPlan({ sceneChanges: [{ action: "rewrite", index: 0, instruction: "x" }] }), () => scene);
    await assert.rejects(runRefine(model.callModel, refineInput("Change scene 1")), ModelOutputError, scene.title);
  }
});

test("an unusable decision is a ModelOutputError with usage, logged as the decide part", async () => {
  for (const output of [{ reply: "Here is the whole plan", plan: keeperPlan() }, editPlan({ reply: "  " })]) {
    const failures: RefineFailure[] = [];
    const model = fakeModel(() => output);
    await assert.rejects(
      runRefine(model.callModel, refineInput("Anything"), { onFailure: (failure) => failures.push(failure) }),
      (error: unknown) => error instanceof ModelOutputError && error.usage.step === "refine",
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].part, "decide");
    assert.equal(failures[0].maxOutputTokens, EDIT_PLAN_MAX_OUTPUT_TOKENS);
  }
});

test("each step gives up at its own deadline", async () => {
  const hung: CallModel = () => new Promise(() => {});
  await assert.rejects(runRefine(hung, refineInput("Anything"), { decideTimeoutMs: 20 }), { name: "TimeoutError" });

  const slowScenes = fakeModel(editPlan({ sceneChanges: [{ action: "rewrite", index: 0, instruction: "x" }] }), () => new Promise(() => {}));
  await assert.rejects(runRefine(slowScenes.callModel, refineInput("Change scene 1"), { sceneTimeoutMs: 20 }), { name: "TimeoutError" });
});

test("the input plan is never mutated", async () => {
  const input = refineInput("Rename and rewrite");
  const model = fakeModel(
    editPlan({ renames: [{ from: "Keeper", to: "Aswin" }], sceneChanges: [{ action: "rewrite", index: 0, instruction: "x" }] }),
    (payload) => payload.scene,
  );
  await runRefine(model.callModel, input);
  assert.deepEqual(input.plan, keeperPlan());
});

// --- Budgets and the specialist path ---

test("budgets: decision then scene rewrites fit both routes; output caps match the brief", () => {
  assert.equal(EDIT_PLAN_MAX_OUTPUT_TOKENS, 3_000);
  assert.equal(EDIT_PLAN_TIMEOUT_MS, 75_000);
  assert.equal(EDIT_SCENE_MAX_OUTPUT_TOKENS, 4_000);
  assert.equal(EDIT_SCENE_TIMEOUT_MS, 100_000);
  for (const maxDuration of [directorMaxDuration, refineMaxDuration]) {
    assert.ok(EDIT_PLAN_TIMEOUT_MS + EDIT_SCENE_TIMEOUT_MS <= maxDuration * 1_000);
  }
  assert.equal(directorMaxDuration, 180);
});

test("a message a specialist handles never reaches the plan edit", async () => {
  let refineCalls = 0;
  const steps: string[] = [];
  const deps: DirectorDeps = {
    callModel: async (call) => {
      steps.push(call.step);
      return { output: { summary: "Sound notes", recommendations: [], edits: [] }, usage: { ...usage(10), step: call.step } };
    },
    refine: async () => {
      refineCalls += 1;
      throw new Error("No plan edit expected");
    },
  };
  const result = await runDirector({ plan: keeperPlan(), messages: [], message: "How should the music work?" }, deps);
  assert.equal(result.mode, "specialists");
  assert.equal(refineCalls, 0);
  assert.deepEqual(steps, ["sound-director"]);
});
