import assert from "node:assert/strict";
import { test } from "node:test";
import { type CallModel, type DirectorDeps, type ModelCall, runDirector } from "../src/lib/agents/orchestrator.ts";
import { findTargetScenes, isSceneStructureEdit } from "../src/lib/agents/scope.ts";
import type { DirectorRequest, ImageReference } from "../src/lib/agents/types.ts";
import type { RefineRequest, ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord } from "../src/lib/usage.ts";

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

// --- Scoped refine ---

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

type FakeRefine = (input: RefineRequest, call: number) => { reply: string; changeSummary: string[]; plan: ShotPlan };

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
      return { ...refine(input, inputs.length), usage: usage(inputs.length) };
    },
  };
  return { deps, inputs, modelCalls };
}

const rewriteScenes: FakeRefine = (input) => ({
  reply: "Scoped reply",
  changeSummary: ["S02_SH01: rewrote the action"],
  plan: {
    ...input.plan,
    title: "Model renamed the film",
    characters: [
      ...input.plan.characters,
      { name: "Postman", role: "Messenger", look: "Blue cap", personality: "Kind", voice: "Warm" },
      { name: "ELIAS", role: "Duplicate", look: "", personality: "", voice: "" },
    ],
    locations: [...input.plan.locations, { name: "Post office", description: "Fluorescent" }],
    scenes: input.plan.scenes.map((scene) => ({
      ...scene,
      title: `${scene.title} (revised)`,
      shots: scene.shots.map((shot) => ({ ...shot, characters: ["Elias", "Postman"], action: "Revised." })),
    })),
  },
});

test("scoped revision sends only the targeted scenes and changes only them", async () => {
  const original = makePlan();
  const input = request("In scene 2, have a postman deliver the letter", original);
  const fake = fakeDeps(rewriteScenes);
  const result = await runDirector(input, fake.deps);

  assert.equal(fake.inputs.length, 1);
  assert.equal(fake.modelCalls.length, 0);
  const sent = fake.inputs[0];
  assert.deepEqual(sent.plan.scenes, [original.scenes[1]]);
  assert.equal(sent.plan.title, original.title);
  assert.deepEqual(sent.plan.characters, original.characters);
  assert.deepEqual(sent.plan.reviewNotes, original.reviewNotes);
  assert.ok(sent.message.startsWith("In scene 2, have a postman deliver the letter"));
  assert.match(sent.message, /Scene 2/);
  assert.deepEqual(sent.messages, input.messages);

  assert.equal(result.mode, "refine");
  assert.equal(result.reply, "Scoped reply");
  assert.deepEqual(result.changeSummary, ["S02_SH01: rewrote the action"]);
  assert.deepEqual(result.usage, [usage(1)]);
  const plan = result.plan;
  assert.ok(plan);
  assert.equal(plan.scenes.length, 4);
  assert.equal(plan.scenes[1].title, "Letter (revised)");
  assert.deepEqual(plan.scenes[0], original.scenes[0]);
  assert.deepEqual(plan.scenes[2], original.scenes[2]);
  assert.deepEqual(plan.scenes[3], original.scenes[3]);
  assert.equal(plan.title, "The Letter");
  assert.deepEqual(input.plan, makePlan());
});

test("new characters and locations from the scoped result are appended once", async () => {
  const fake = fakeDeps(rewriteScenes);
  const result = await runDirector(request("Rewrite the last scene with a postman"), fake.deps);
  const plan = result.plan;
  assert.ok(plan);
  assert.deepEqual(plan.characters.map(({ name }) => name), ["Elias", "Postman"]);
  assert.deepEqual(plan.locations.map(({ name }) => name), ["Kitchen", "Post office"]);
  assert.equal(plan.scenes[3].title, "Night (revised)");
  assert.deepEqual(plan.scenes.slice(0, 3), makePlan().scenes.slice(0, 3));
});

test("multiple targeted scenes splice back at their original positions", async () => {
  const fake = fakeDeps(rewriteScenes);
  const result = await runDirector(request("Rework scenes 1 and 3"), fake.deps);
  assert.deepEqual(fake.inputs[0].plan.scenes.map(({ title }) => title), ["Morning", "Porch"]);
  assert.deepEqual(result.plan?.scenes.map(({ title }) => title), ["Morning (revised)", "Letter", "Porch (revised)", "Night"]);
});

test("scene count mismatch falls back to one full refine", async () => {
  const fake = fakeDeps((input, call) =>
    call === 1
      ? { reply: "Scoped", changeSummary: ["x"], plan: { ...input.plan, scenes: [...input.plan.scenes, ...input.plan.scenes] } }
      : { reply: "Full", changeSummary: ["Full change"], plan: { ...input.plan, title: "Full" } },
  );
  const result = await runDirector(request("Change scene 2"), fake.deps);
  assert.equal(fake.inputs.length, 2);
  assert.equal(fake.inputs[1].plan.scenes.length, 4);
  assert.equal(fake.inputs[1].message, "Change scene 2");
  assert.equal(result.reply, "Full");
  assert.equal(result.plan?.title, "Full");
  assert.deepEqual(result.usage, [usage(1), usage(2)]);
});

test("untargeted, whole-film and scene-structure requests use a single full refine", async () => {
  for (const message of ["Rename Elias to Tom", "Make every scene rainy", "Delete scene 2", "Rework scenes 1-4"]) {
    const fake = fakeDeps((input) => ({ reply: "Full", changeSummary: [], plan: { ...input.plan, title: "Full" } }));
    const result = await runDirector(request(message), fake.deps);
    assert.equal(fake.inputs.length, 1, message);
    assert.equal(fake.inputs[0].message, message);
    assert.deepEqual(fake.inputs[0].plan, makePlan(), message);
    assert.equal(result.plan?.title, "Full", message);
    assert.deepEqual(result.usage, [usage(1)], message);
  }
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
  const payload = JSON.parse(call.input) as { plan: { references?: { name: string }[] } };
  assert.equal(payload.plan.references?.[0]?.name, "Dusk porch");
});
