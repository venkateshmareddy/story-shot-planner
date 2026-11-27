import assert from "node:assert/strict";
import { test } from "node:test";
import { cinematographyDirector } from "../src/lib/agents/cinematography-director.ts";
import { continuityReviewer } from "../src/lib/agents/continuity-reviewer.ts";
import { editingDirector } from "../src/lib/agents/editing-director.ts";
import { mergeEdits, sanitizeEdits } from "../src/lib/agents/merge.ts";
import {
  type CallModel,
  DirectorError,
  type DirectorDeps,
  type ModelCall,
  ModelOutputError,
  runDirector,
} from "../src/lib/agents/orchestrator.ts";
import { selectSpecialists } from "../src/lib/agents/router.ts";
import { directorRequest } from "../src/lib/agents/schemas.ts";
import { soundDirector } from "../src/lib/agents/sound-director.ts";
import { storyAnalyst } from "../src/lib/agents/story-analyst.ts";
import type { DirectorRequest, SpecialistId } from "../src/lib/agents/types.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord, UsageStep } from "../src/lib/usage.ts";

function makePlan(title = "The Letter"): ShotPlan {
  const shot = (overrides: Partial<ShotPlan["scenes"][number]["shots"][number]> = {}) => ({
    seconds: 4,
    framing: "Medium shot",
    camera: "Static tripod",
    characters: ["Elias"],
    location: "Kitchen",
    action: "Elias reads the letter.",
    dialogue: [{ speaker: "Elias", line: "She wrote back.", delivery: "Whispered" }],
    emotion: "Hope",
    sound: "Kettle hiss",
    ...overrides,
  });
  return {
    title,
    logline: "A widower finds a letter.",
    intent: "Quiet grief turning to hope.",
    characters: [
      { name: "Elias", role: "Lead", look: "Grey cardigan", personality: "Reserved", voice: "Low" },
      { name: "Mara", role: "Daughter", look: "Red coat", personality: "Direct", voice: "Bright" },
    ],
    locations: [
      { name: "Kitchen", description: "Morning light" },
      { name: "Porch", description: "Rainy dusk" },
    ],
    scenes: [
      { title: "Morning", shots: [shot(), shot({ action: "Elias looks out of the window.", dialogue: [] })] },
      { title: "Porch", shots: [shot({ location: "Porch", characters: ["Mara"], dialogue: [] })] },
    ],
    reviewNotes: [],
  };
}

function request(message: string, plan = makePlan()): DirectorRequest {
  return {
    plan,
    messages: [{ role: "user", text: "Earlier note" }],
    message,
    collected: [
      { label: "Tone", detail: "Melancholic" },
      { label: "Sound", detail: "Mostly silence with rain" },
    ],
  };
}

const usageFor = (step: UsageStep): UsageRecord => ({
  step,
  model: "fake",
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
});

const advice = (summary: string, edits: unknown[] = []) => ({
  summary,
  recommendations: [
    { target: "S01_SH01", issue: "Flat", recommendation: `${summary} rec`, rationale: "Purpose", priority: "medium" },
  ],
  edits,
});

type Handler = (call: ModelCall) => unknown | Promise<unknown>;

function fakeDeps(handlers: Partial<Record<UsageStep, Handler>>, delayMs = 0) {
  const calls: ModelCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let refineCalls = 0;
  const callModel: CallModel = async (call) => {
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const handler = handlers[call.step];
      if (!handler) throw new Error(`No fake for ${call.step}`);
      return { output: await handler(call), usage: usageFor(call.step) };
    } finally {
      inFlight -= 1;
    }
  };
  const deps: DirectorDeps = {
    callModel,
    refine: async (input) => {
      refineCalls += 1;
      return {
        reply: "Refined.",
        changeSummary: ["Renamed Elias"],
        plan: { ...input.plan, title: "Refined" },
        usage: usageFor("refine"),
      };
    },
  };
  return {
    deps,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    get refineCalls() {
      return refineCalls;
    },
  };
}

function keysOf(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, keys);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      keysOf(item, keys);
    }
  }
  return keys;
}

// --- Specialist contexts and schemas ---

const contextCases = [
  { def: storyAnalyst, has: ["logline", "intent", "action", "dialogue"], lacks: ["framing", "camera", "sound", "seconds"] },
  { def: cinematographyDirector, has: ["framing", "camera", "action"], lacks: ["sound", "seconds", "dialogue", "logline"] },
  { def: soundDirector, has: ["sound", "action", "emotion", "dialogue"], lacks: ["framing", "camera", "seconds", "logline"] },
  { def: editingDirector, has: ["seconds", "spokenWords"], lacks: ["framing", "camera", "sound", "dialogue"] },
  { def: continuityReviewer, has: ["location", "characters", "speakers"], lacks: ["framing", "camera", "sound", "seconds"] },
];

for (const { def, has, lacks } of contextCases) {
  test(`${def.id} context contains only its fields`, () => {
    const context = def.buildContext(makePlan());
    const keys = keysOf(context);
    for (const key of has) assert.ok(keys.has(key), `${def.id} missing ${key}`);
    for (const key of lacks) assert.ok(!keys.has(key), `${def.id} leaks ${key}`);
    assert.ok(JSON.stringify(context).includes("S01_SH02"));
    assert.ok(def.maxOutputTokens <= 1_500);
  });

  test(`${def.id} schema accepts valid and rejects invalid output`, () => {
    const field = def.fields[0];
    const valid = advice("ok", [{ scene: 1, shot: 1, field, value: "x" }]);
    assert.ok(def.schema.safeParse(valid).success);
    const foreign = ["framing", "sound", "seconds", "logline", "location"].find((name) => !def.fields.includes(name as never));
    assert.ok(!def.schema.safeParse(advice("ok", [{ scene: 1, shot: 1, field: foreign, value: "x" }])).success);
    assert.ok(!def.schema.safeParse(advice("ok", [{ scene: 0, shot: 1, field, value: "x" }])).success);
    assert.ok(!def.schema.safeParse({ ...valid, recommendations: [{ ...valid.recommendations[0], priority: "urgent" }] }).success);
    assert.ok(!def.schema.safeParse({ recommendations: [], edits: [] }).success);
  });
}

// --- Router ---

test("router selects the matching domain", () => {
  assert.deepEqual(selectSpecialists("Make shot 3 a close-up"), ["cinematography-director"]);
  assert.deepEqual(selectSpecialists("Add rain ambience and quiet music"), ["sound-director"]);
  assert.deepEqual(selectSpecialists("Tighten the pacing of scene 2"), ["editing-director"]);
  assert.deepEqual(selectSpecialists("Is the timeline consistent?"), ["continuity-reviewer"]);
  assert.deepEqual(selectSpecialists("What is the protagonist's motivation?"), ["story-analyst"]);
  assert.deepEqual(selectSpecialists("Better lighting and a softer score"), ["cinematography-director", "sound-director"]);
});

test("review intent selects several specialists", () => {
  assert.equal(selectSpecialists("Review my film and give me feedback").length, 5);
  assert.deepEqual(selectSpecialists("Critique the sound and the pacing"), ["sound-director", "editing-director"]);
  assert.ok(selectSpecialists("What do you think of the plan?").length > 1);
});

test("unrelated or structural requests fall back to refine", () => {
  assert.deepEqual(selectSpecialists("Rename Elias to Tom"), []);
  assert.deepEqual(selectSpecialists("Delete shot 4"), []);
  assert.deepEqual(selectSpecialists("Add a new scene at the beach"), []);
});

test("request schema validates director input", () => {
  assert.ok(directorRequest.safeParse(request("Review")).success);
  assert.ok(!directorRequest.safeParse({ ...request("Review"), message: "  " }).success);
});

// --- Orchestrator ---

test("specialists run in parallel", async () => {
  const fake = fakeDeps(
    {
      "story-analyst": () => advice("Story"),
      "cinematography-director": () => advice("Camera"),
      "sound-director": () => advice("Sound"),
      "editing-director": () => advice("Edit"),
      "continuity-reviewer": () => advice("Continuity"),
      orchestrator: () => ({ reply: "Team reply", conflicts: [] }),
    },
    60,
  );
  const started = Date.now();
  const result = await runDirector(request("Review the film"), fake.deps);
  const elapsed = Date.now() - started;
  assert.equal(fake.maxInFlight, 5);
  assert.ok(elapsed < 60 * 5, `took ${elapsed}ms`);
  assert.equal(result.specialists.length, 5);
  assert.equal(fake.calls.filter((call) => call.step === "orchestrator").length, 1);
  assert.ok(fake.calls.length <= 6);
});

test("single specialist uses its summary without synthesis", async () => {
  const fake = fakeDeps({ "cinematography-director": () => advice("Use a tighter frame.") });
  const result = await runDirector(request("Make shot 1 a close-up"), fake.deps);
  assert.equal(result.mode, "specialists");
  assert.equal(result.reply, "Use a tighter frame.");
  assert.deepEqual(result.specialists, ["cinematography-director"]);
  assert.ok(!fake.calls.some((call) => call.step === "orchestrator"));
  assert.equal(result.recommendations[0].specialist, "cinematography-director");
});

test("synthesis runs once when two specialists succeed", async () => {
  const fake = fakeDeps({
    "cinematography-director": () => advice("Camera"),
    "sound-director": () => advice("Sound"),
    orchestrator: (call) => {
      const input = JSON.parse(call.input);
      assert.equal(input.specialists.length, 2);
      return { reply: "One voice.", conflicts: ["Camera wants silence; sound wants rain."] };
    },
  });
  const result = await runDirector(request("Better lighting and a softer score"), fake.deps);
  assert.equal(result.reply, "One voice.");
  assert.deepEqual(result.conflicts, ["Camera wants silence; sound wants rain."]);
  assert.equal(fake.calls.at(-1)?.maxOutputTokens, 700);
});

test("synthesis failure falls back to a deterministic reply", async () => {
  const fake = fakeDeps({
    "cinematography-director": () => advice("Camera"),
    "sound-director": () => advice("Sound"),
    orchestrator: () => {
      throw new Error("down");
    },
  });
  const result = await runDirector(request("Better lighting and a softer score"), fake.deps);
  assert.equal(result.reply, "Cinematography: Camera\n\nSound: Sound");
  assert.equal(result.usage.length, 2);
});

test("one failure returns the others and records it", async () => {
  const fake = fakeDeps({
    "cinematography-director": () => advice("Camera"),
    "sound-director": () => {
      throw new Error("boom");
    },
  });
  const result = await runDirector(request("Better lighting and a softer score"), fake.deps);
  assert.deepEqual(result.specialists, ["cinematography-director"]);
  assert.deepEqual(result.failed, ["sound-director"]);
  assert.equal(result.reply, "Camera");
});

test("invalid output and timeouts count as failures", async () => {
  const fake = fakeDeps({
    "cinematography-director": () => ({ summary: "missing arrays" }),
    "sound-director": () => new Promise(() => {}),
    "story-analyst": () => advice("Story"),
  });
  const result = await runDirector(request("Lighting, score and the protagonist's arc"), fake.deps, {
    specialistTimeoutMs: 30,
  });
  assert.deepEqual(result.specialists, ["story-analyst"]);
  assert.deepEqual(new Set(result.failed), new Set(["cinematography-director", "sound-director"]));
});

test("all specialists failing throws a typed error", async () => {
  const fake = fakeDeps({
    "cinematography-director": () => {
      throw new Error("a");
    },
    "sound-director": () => {
      throw new Error("b");
    },
  });
  await assert.rejects(runDirector(request("Better lighting and a softer score"), fake.deps), (error) => {
    assert.ok(error instanceof DirectorError);
    assert.deepEqual(error.failed, ["cinematography-director", "sound-director"]);
    return true;
  });
});

test("edits merge into a copy; invalid edits are dropped", async () => {
  const plan = makePlan();
  const snapshot = structuredClone(plan);
  const fake = fakeDeps({
    "cinematography-director": () =>
      advice("Camera", [
        { scene: 1, shot: 2, field: "framing", value: "Close-up on the window" },
        { scene: 9, shot: 1, field: "framing", value: "out of range scene" },
        { scene: 1, shot: 7, field: "camera", value: "out of range shot" },
        { scene: 1, shot: 1, field: "sound", value: "not owned" },
        { scene: 1, shot: 1, field: "framing", value: "Medium shot" },
      ]),
    "editing-director": () =>
      advice("Edit", [
        { scene: 1, shot: 1, field: "seconds", value: "2.5" },
        { scene: 1, shot: 2, field: "seconds", value: "fast" },
        { scene: 2, shot: 1, field: "seconds", value: "-3" },
      ]),
    orchestrator: () => ({ reply: "Merged.", conflicts: [] }),
  });
  const result = await runDirector(request("Change the framing and tighten the pacing", plan), fake.deps);
  assert.deepEqual(plan, snapshot);
  assert.ok(result.plan);
  assert.notEqual(result.plan, plan);
  assert.equal(result.plan.scenes[0].shots[1].framing, "Close-up on the window");
  assert.equal(result.plan.scenes[0].shots[0].seconds, 2.5);
  assert.equal(result.plan.scenes[0].shots[0].sound, "Kettle hiss");
  assert.equal(result.plan.scenes[1].shots[0].seconds, 4);
  assert.equal(result.changeSummary.length, 2);
  assert.match(result.changeSummary[0], /^S01_SH01 duration 4s → 2.5s \(Editing\)$/);
});

test("advice-only response has no plan", async () => {
  const fake = fakeDeps({ "sound-director": () => advice("Let the silence breathe.") });
  const result = await runDirector(request("How should the music work?"), fake.deps);
  assert.equal(result.plan, null);
  assert.deepEqual(result.changeSummary, []);
});

test("same field from two specialists keeps one by priority and records a conflict", () => {
  const plan = makePlan();
  const story = sanitizeEdits(plan, "story-analyst", ["action"], [
    { scene: 1, shot: 1, field: "action", value: "Elias tears the letter." },
  ]);
  const continuity = sanitizeEdits(plan, "continuity-reviewer", ["action"], [
    { scene: 1, shot: 1, field: "action", value: "Elias folds the letter." },
  ]);
  const merged = mergeEdits(plan, [...continuity, ...story]);
  assert.equal(merged.plan?.scenes[0].shots[0].action, "Elias tears the letter.");
  assert.equal(merged.conflicts.length, 1);
  assert.match(merged.conflicts[0], /kept Story's proposal/);
  assert.equal(plan.scenes[0].shots[0].action, "Elias reads the letter.");
});

test("continuity characters keep only known names", () => {
  const edits = sanitizeEdits(makePlan(), "continuity-reviewer", ["characters"], [
    { scene: 2, shot: 1, field: "characters", value: "mara, Elias, Stranger" },
  ]);
  assert.deepEqual(edits[0].value, ["Mara", "Elias"]);
});

test("no specialist match falls back to refine", async () => {
  const fake = fakeDeps({});
  const result = await runDirector(request("Rename Elias to Tom"), fake.deps);
  assert.equal(result.mode, "refine");
  assert.equal(fake.refineCalls, 1);
  assert.equal(fake.calls.length, 0);
  assert.equal(result.plan?.title, "Refined");
  assert.deepEqual(result.usage.map((record) => record.step), ["refine"]);
});

test("one usage record per model call, including unusable results", async () => {
  const fake = fakeDeps({
    "cinematography-director": () => advice("Camera"),
    "sound-director": () => advice("Sound"),
    "editing-director": () => advice("Edit"),
    orchestrator: () => ({ reply: "", conflicts: [] }),
  });
  const failing: CallModel = async (call) => {
    if (call.step === "editing-director") throw new ModelOutputError("incomplete", usageFor(call.step));
    return fake.deps.callModel(call);
  };
  const result = await runDirector(request("Lighting, score and pacing"), { ...fake.deps, callModel: failing });
  assert.deepEqual(
    result.usage.map((record) => record.step).sort(),
    ["cinematography-director", "editing-director", "orchestrator", "sound-director"],
  );
  assert.deepEqual(result.failed, ["editing-director"]);
});

test("concurrent runs with different plans don't leak", async () => {
  const edit = (call: ModelCall) => {
    const title = JSON.parse(call.input).plan.title as string;
    return advice(title, [{ scene: 1, shot: 1, field: "framing", value: `Wide for ${title}` }]);
  };
  const fake = fakeDeps({ "cinematography-director": edit }, 20);
  const [a, b] = await Promise.all([
    runDirector(request("Make it a wide angle", makePlan("Alpha")), fake.deps),
    runDirector(request("Make it a wide angle", makePlan("Beta")), fake.deps),
  ]);
  assert.equal(a.plan?.title, "Alpha");
  assert.equal(a.plan?.scenes[0].shots[0].framing, "Wide for Alpha");
  assert.equal(b.plan?.title, "Beta");
  assert.equal(b.plan?.scenes[0].shots[0].framing, "Wide for Beta");
  assert.equal(a.reply, "Alpha");
  assert.equal(b.reply, "Beta");
});

test("specialist input carries message, approved context and its plan slice", async () => {
  const seen = new Map<SpecialistId, Record<string, unknown>>();
  const fake = fakeDeps({
    "sound-director": (call) => {
      seen.set("sound-director", JSON.parse(call.input));
      return advice("Sound");
    },
  });
  await runDirector(request("How should the music work?"), fake.deps);
  const input = seen.get("sound-director");
  assert.equal(input?.message, "How should the music work?");
  assert.deepEqual((input?.approved as { collected: { label: string }[] }).collected[0].label, "Sound");
  assert.ok(!JSON.stringify(input).includes("framing"));
});
