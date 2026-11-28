import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PLAN_DIFF_TEXT, planDiff } from "../src/lib/plan-diff.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";

type Shot = ShotPlan["scenes"][number]["shots"][number];

const shot = (action: string, extra: Partial<Shot> = {}): Shot => ({
  seconds: 4,
  framing: "Wide",
  camera: "Still",
  characters: ["Mara"],
  location: "Pier",
  action,
  dialogue: [],
  emotion: "Calm",
  sound: "Waves",
  ...extra,
});

const scene = (title: string, actions = [`${title} opens`]) => ({ title, shots: actions.map((action) => shot(action)) });

function makePlan(): ShotPlan {
  return {
    title: "The Keeper",
    logline: "A keeper finds a stranger.",
    intent: "Loneliness ends.",
    characters: [
      { name: "Mara", role: "Keeper", look: "Grey coat", personality: "Quiet", voice: "Low" },
      { name: "Tom", role: "Stranger", look: "Wet", personality: "Nervous", voice: "Fast" },
    ],
    locations: [{ name: "Pier", description: "Old wooden pier" }],
    scenes: [scene("Storm", ["Waves hit", "Mara looks out"]), scene("Rescue"), scene("Morning")],
    reviewNotes: [],
  };
}

test("identical plans have no changes", () => {
  assert.deepEqual(planDiff(makePlan(), makePlan()), { changes: [], hidden: 0 });
});

test("overview, character and place changes are listed in plain words", () => {
  const after = makePlan();
  after.logline = "A keeper rescues a stranger.";
  after.characters[0] = { ...after.characters[0], personality: "Stubborn" };
  after.characters = [after.characters[0], { name: "Ana", role: "Pilot", look: "", personality: "", voice: "" }];
  after.locations[0] = { ...after.locations[0], description: "New stone pier" };
  const { changes } = planDiff(makePlan(), after);
  assert.deepEqual(changes, [
    { kind: "changed", where: "Overview", what: "One-line summary", before: "A keeper finds a stranger.", after: "A keeper rescues a stranger." },
    { kind: "changed", where: "Character: Mara", what: "Personality", before: "Quiet", after: "Stubborn" },
    { kind: "removed", where: "Character: Tom", what: "Character", before: "Stranger", after: "" },
    { kind: "added", where: "Character: Ana", what: "Character", before: "", after: "Pilot" },
    { kind: "changed", where: "Place: Pier", what: "Description", before: "Old wooden pier", after: "New stone pier" },
  ]);
});

test("shot changes are keyed by shot id with old and new values", () => {
  const after = makePlan();
  after.scenes[0].shots[1] = shot("Mara runs to the boat", {
    dialogue: [{ speaker: "Mara", line: "Hold on!", delivery: "shouting" }],
  });
  const { changes } = planDiff(makePlan(), after);
  assert.deepEqual(changes, [
    { kind: "changed", where: "S01_SH02", what: "What happens", before: "Mara looks out", after: "Mara runs to the boat" },
    { kind: "changed", where: "S01_SH02", what: "Dialogue", before: "", after: "Mara (shouting): Hold on!" },
  ]);
});

test("added and removed shots inside a scene", () => {
  const added = makePlan();
  added.scenes[1].shots.push(shot("Tom coughs"));
  assert.deepEqual(planDiff(makePlan(), added).changes, [
    { kind: "added", where: "S02_SH02", what: "Shot", before: "", after: "Tom coughs" },
  ]);
  const removed = makePlan();
  removed.scenes[0].shots.pop();
  assert.deepEqual(planDiff(makePlan(), removed).changes, [
    { kind: "removed", where: "S01_SH02", what: "Shot", before: "Mara looks out", after: "" },
  ]);
});

test("an inserted scene is one addition; later scenes are matched by title, not position", () => {
  const after = makePlan();
  after.scenes.splice(1, 0, scene("Lighthouse"));
  assert.deepEqual(planDiff(makePlan(), after).changes, [
    { kind: "added", where: "New S02", what: "Scene", before: "", after: "Lighthouse" },
  ]);
});

test("a removed scene uses its current number", () => {
  const after = makePlan();
  after.scenes.splice(1, 1);
  assert.deepEqual(planDiff(makePlan(), after).changes, [
    { kind: "removed", where: "S02", what: "Scene", before: "Rescue", after: "" },
  ]);
});

test("a renamed scene in the same place is a title change, not a removal", () => {
  const after = makePlan();
  after.scenes[1] = { ...after.scenes[1], title: "The rescue" };
  assert.deepEqual(planDiff(makePlan(), after).changes, [
    { kind: "changed", where: "S02", what: "Scene title", before: "Rescue", after: "The rescue" },
  ]);
});

test("long values are clipped and the list is capped with a hidden count", () => {
  const after = makePlan();
  after.intent = "x".repeat(MAX_PLAN_DIFF_TEXT * 2);
  after.scenes.forEach((item, index) => {
    item.shots[0] = shot(`New action ${index}`);
  });
  const full = planDiff(makePlan(), after);
  assert.equal(full.changes[0].after.length, MAX_PLAN_DIFF_TEXT);
  assert.ok(full.changes[0].after.endsWith("…"));
  assert.equal(full.hidden, 0);
  const capped = planDiff(makePlan(), after, 2);
  assert.equal(capped.changes.length, 2);
  assert.equal(capped.hidden, full.changes.length - 2);
});

test("whitespace-only differences are not changes", () => {
  const after = makePlan();
  after.scenes[2].shots[0] = shot("  Morning   opens ");
  assert.deepEqual(planDiff(makePlan(), after).changes, []);
});
