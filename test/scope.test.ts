import assert from "node:assert/strict";
import { test } from "node:test";
import { type CallModel, type DirectorDeps, type ModelCall, runDirector } from "../src/lib/agents/orchestrator.ts";
import { findTargetScenes, isSceneStructureEdit } from "../src/lib/agents/scope.ts";
import type { DirectorRequest, ImageReference } from "../src/lib/agents/types.ts";
import type { RefineRequest, ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord } from "../src/lib/usage.ts";
import { sectionJson } from "./model-input.ts";

// --- Parsing ---

test("finds explicitly numbered scenes", () => {
  assert.deepEqual(findTargetScenes("Make scene 2 darker", 5), [1]);
  assert.deepEqual(findTargetScenes("Rework scenes 2 and 3", 5), [1, 2]);
  assert.deepEqual(findTargetScenes("Rework scenes 1, 3 and 5", 5), [0, 2, 4]);
  assert.deepEqual(findTargetScenes("Tighten scenes 2-4", 5), [1, 2, 3]);
  assert.deepEqual(findTargetScenes("Fix scene two", 5), [1]);
  assert.deepEqual(findTargetScenes("Change shot 3 of scene 2 to night", 5), [1]);
  assert.deepEqual(findTargetScenes("Set scene 2 to 10 seconds per shot", 5), [1]);
});

test("finds scene and shot codes", () => {
  assert.deepEqual(findTargetScenes("Rewrite S02", 5), [1]);
  assert.deepEqual(findTargetScenes("Give S02_SH03 a line for Mara", 5), [1]);
  assert.deepEqual(findTargetScenes("Swap the lines in S01_SH01 and s03_sh02", 5), [0, 2]);
});

test("finds ordinal, opening and final scenes", () => {
  assert.deepEqual(findTargetScenes("Make the first scene warmer", 5), [0]);
  assert.deepEqual(findTargetScenes("Rewrite the second and third scenes", 5), [1, 2]);
  assert.deepEqual(findTargetScenes("Change the tenth scene", 10), [9]);
  assert.deepEqual(findTargetScenes("Punch up the last scene", 5), [4]);
  assert.deepEqual(findTargetScenes("Rework the opening scene", 5), [0]);
  assert.deepEqual(findTargetScenes("Rework the final scene", 3), [2]);
  assert.deepEqual(findTargetScenes("Rework the opening scene and the final scene", 3), [0, 2]);
});

test("ignores out-of-range scenes and dedupes", () => {
  assert.deepEqual(findTargetScenes("Fix scene 9", 3), []);
  assert.deepEqual(findTargetScenes("Fix scene 0 and scene 2", 3), [1]);
  assert.deepEqual(findTargetScenes("Fix the tenth scene", 3), []);
  assert.deepEqual(findTargetScenes("Fix scene 2, S02 and the second scene", 3), [1]);
  assert.deepEqual(findTargetScenes("Fix scene 2", 0), []);
});

test("returns [] when nothing specific or the whole film is meant", () => {
  assert.deepEqual(findTargetScenes("Rename Elias to Tom", 3), []);
  assert.deepEqual(findTargetScenes("Make this scene sadder", 3), []);
  assert.deepEqual(findTargetScenes("Give Mara more lines in all scenes", 3), []);
  assert.deepEqual(findTargetScenes("Change scene 2 and the whole film's tone", 3), []);
  assert.deepEqual(findTargetScenes("Make every scene rainy", 3), []);
  assert.deepEqual(findTargetScenes("Rename Mara across the whole film", 3), []);
});

test("detects edits that change the scene list", () => {
  assert.ok(isSceneStructureEdit("Delete scene 2"));
  assert.ok(isSceneStructureEdit("Merge scenes 2 and 3"));
  assert.ok(isSceneStructureEdit("Add a new scene after the first scene"));
  assert.ok(isSceneStructureEdit("Move the last scene to the start"));
  assert.ok(!isSceneStructureEdit("Add a shot to scene 2"));
  assert.ok(!isSceneStructureEdit("Remove the dialogue from scene 2"));
});

// --- The refine fallback: one plan edit, named scenes are only a hint ---

function makePlan(): ShotPlan {
  const shot = (location: string, action: string) => ({
    seconds: 4,
    framing: "Medium shot",
    camera: "Static",
    characters: ["Elias"],
    location,
    action,
    dialogue: [],
    emotion: "Calm",
    sound: "Room tone",
  });
  return {
    title: "The Letter",
    logline: "A widower finds a letter.",
    intent: "Grief turning to hope.",
    characters: [{ name: "Elias", role: "Lead", look: "Cardigan", personality: "Reserved", voice: "Low" }],
    locations: [{ name: "Kitchen", description: "Morning light" }],
    scenes: [
      { title: "Morning", shots: [shot("Kitchen", "Elias makes tea.")] },
      { title: "Letter", shots: [shot("Kitchen", "Elias opens the letter."), shot("Kitchen", "He reads.")] },
      { title: "Porch", shots: [shot("Kitchen", "Elias steps outside.")] },
      { title: "Night", shots: [shot("Kitchen", "Elias sleeps.")] },
    ],
    reviewNotes: ["Keep it quiet."],
  };
}

const request = (message: string, plan = makePlan()): DirectorRequest => ({
  plan,
  messages: [{ role: "user", text: "Earlier note" }],
  message,
});

const usage = (inputTokens: number): UsageRecord => ({
  step: "refine",
  model: "fake",
  inputTokens,
  outputTokens: 1,
  totalTokens: inputTokens + 1,
});

type FakeRefine = (input: RefineRequest) => { reply: string; changeSummary: string[]; plan: ShotPlan; changed: boolean };

function fakeDeps(refine: FakeRefine) {
  const inputs: RefineRequest[] = [];
  const modelCalls: ModelCall[] = [];
  const callModel: CallModel = async (call) => {
    modelCalls.push(call);
    return {
      output: { summary: "Camera notes", recommendations: [], edits: [] },
      usage: { ...usage(1), step: call.step },
    };
  };
  const deps: DirectorDeps = {
    callModel,
    refine: async (input) => {
      inputs.push(structuredClone(input));
      return { ...refine(input), usage: [usage(inputs.length), usage(10)] };
    },
  };
  return { deps, inputs, modelCalls };
}

const rewriteScenes: FakeRefine = (input) => ({
  reply: "I'll rewrite Scene 2. Press Apply to update your board.",
  changeSummary: ["S02: the postman delivers the letter"],
  plan: { ...input.plan, scenes: input.plan.scenes.map((scene, index) => (index === 1 ? { ...scene, title: "Letter (revised)" } : scene)) },
  changed: true,
});

test("every refine-path request makes one plan edit with the whole plan and the message as typed", async () => {
  const messages = [
    "In scene 2, have a postman deliver the letter",
    "Rework scenes 1 and 3",
    "Rename Elias to Tom",
    "Make every scene rainy",
    "Delete scene 2",
    "Rework scenes 1-4",
  ];
  for (const message of messages) {
    const original = makePlan();
    const input = request(message, original);
    const fake = fakeDeps(rewriteScenes);
    const result = await runDirector(input, fake.deps);
    assert.equal(fake.inputs.length, 1, message);
    assert.equal(fake.modelCalls.length, 0, message);
    assert.equal(fake.inputs[0].message, message, message);
    assert.deepEqual(fake.inputs[0].plan, makePlan(), message);
    assert.deepEqual(fake.inputs[0].messages, input.messages, message);
    assert.equal(result.mode, "refine", message);
    assert.deepEqual(input.plan, makePlan(), message);
  }
});

test("a changed plan becomes the proposal with every call's usage record", async () => {
  const fake = fakeDeps(rewriteScenes);
  const result = await runDirector(request("In scene 2, have a postman deliver the letter"), fake.deps);
  assert.equal(result.reply, "I'll rewrite Scene 2. Press Apply to update your board.");
  assert.deepEqual(result.changeSummary, ["S02: the postman delivers the letter"]);
  assert.deepEqual(result.plan?.scenes.map(({ title }) => title), ["Morning", "Letter (revised)", "Porch", "Night"]);
  assert.deepEqual(result.usage, [usage(1), usage(10)]);
});

test("an answer without a change has no proposal: plan null and no change bullets", async () => {
  const fake = fakeDeps((input) => ({ reply: "Scene 2 runs 8 seconds.", changeSummary: ["stray"], plan: input.plan, changed: false }));
  const result = await runDirector(request("How long is scene 2?"), fake.deps);
  assert.equal(result.mode, "refine");
  assert.equal(result.reply, "Scene 2 runs 8 seconds.");
  assert.equal(result.plan, null);
  assert.deepEqual(result.changeSummary, []);
  assert.equal(result.usage.length, 2);
});

// --- Reference images reach the cinematography specialist ---

test("reference images are passed to the cinematography context", async () => {
  const reference: ImageReference = {
    id: "ref-1",
    name: "Dusk porch",
    summary: "Porch at dusk",
    composition: "Centered doorway",
    lighting: "Warm practical",
    cameraAngle: "Low",
    colour: "Amber",
    environment: "Porch",
    mood: "Hopeful",
    shotIdeas: "Silhouette in the doorway",
  };
  const fake = fakeDeps(rewriteScenes);
  await runDirector({ ...request("Improve the camera angles"), references: [reference] }, fake.deps);
  const call = fake.modelCalls.find(({ step }) => step === "cinematography-director");
  assert.ok(call);
  const plan = sectionJson<{ references?: { name: string }[] }>(call.input, "PLAN (JSON)");
  assert.equal(plan?.references?.[0]?.name, "Dusk porch");
});
