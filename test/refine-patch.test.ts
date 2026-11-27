import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRefinePatch,
  applyRenames,
  MAX_RENAME_CHARACTERS,
  renameNameColumns,
  validRenames,
} from "../src/lib/refine-patch.ts";
import { MAX_RENAMES, type RefinePatch, type SceneEdit, type ShotPlan } from "../src/lib/story-planning.ts";

type Scene = ShotPlan["scenes"][number];
type Shot = Scene["shots"][number];

const shot = (action: string, overrides: Partial<Shot> = {}): Shot => ({
  seconds: 4,
  framing: "Medium shot",
  camera: "Static",
  characters: ["Elias"],
  location: "Kitchen",
  action,
  dialogue: [],
  emotion: "Calm",
  sound: "Room tone",
  ...overrides,
});

const scene = (title: string, shots: Shot[] = [shot(`${title} action`)]): Scene => ({ title, shots });

function makePlan(): ShotPlan {
  return {
    title: "The Letter",
    logline: "A widower finds a letter.",
    intent: "Grief turning to hope.",
    characters: [{ name: "Elias", role: "Lead", look: "Cardigan", personality: "Reserved", voice: "Low" }],
    locations: [{ name: "Kitchen", description: "Morning light" }],
    scenes: [scene("Morning"), scene("Letter"), scene("Porch"), scene("Night")],
    reviewNotes: ["Keep it quiet."],
  };
}

function patch(overrides: Partial<RefinePatch> = {}): RefinePatch {
  return {
    reply: "Done.",
    changeSummary: [],
    title: null,
    logline: null,
    intent: null,
    characters: null,
    locations: null,
    sceneEdits: [],
    reviewNotes: null,
    ...overrides,
  };
}

const titles = (plan: ShotPlan | null) => plan?.scenes.map(({ title }) => title);

// --- applyRefinePatch ---

test("an empty patch keeps the plan as it is", () => {
  assert.deepEqual(applyRefinePatch(makePlan(), patch()), makePlan());
});

test("null fields stay unchanged; changed fields and lists replace the old ones", () => {
  const characters = [{ name: "Tom", role: "Lead", look: "Coat", personality: "Warm", voice: "Soft" }];
  const result = applyRefinePatch(
    makePlan(),
    patch({ title: "The Reply", intent: "Hope.", characters, locations: [], reviewNotes: ["Suggestion: add rain."] }),
  );
  assert.ok(result);
  assert.equal(result.title, "The Reply");
  assert.equal(result.logline, makePlan().logline);
  assert.equal(result.intent, "Hope.");
  assert.deepEqual(result.characters, characters);
  assert.deepEqual(result.locations, []);
  assert.deepEqual(result.reviewNotes, ["Suggestion: add rain."]);
  assert.deepEqual(result.scenes, makePlan().scenes);
});

test("a blank title, logline or intent is never applied", () => {
  const result = applyRefinePatch(makePlan(), patch({ title: "  ", logline: "", intent: "\n" }));
  assert.equal(result?.title, "The Letter");
  assert.equal(result?.logline, makePlan().logline);
  assert.equal(result?.intent, makePlan().intent);
});

test("replace, remove and insert_after apply at their positions", () => {
  const replaced = applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "replace", index: 1, scene: scene("New letter") }] }));
  assert.deepEqual(titles(replaced), ["Morning", "New letter", "Porch", "Night"]);
  const removed = applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "remove", index: 3, scene: null }] }));
  assert.deepEqual(titles(removed), ["Morning", "Letter", "Porch"]);
  const first = applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "insert_after", index: -1, scene: scene("Prologue") }] }));
  assert.deepEqual(titles(first), ["Prologue", "Morning", "Letter", "Porch", "Night"]);
  const last = applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "insert_after", index: 3, scene: scene("Epilogue") }] }));
  assert.deepEqual(titles(last), ["Morning", "Letter", "Porch", "Night", "Epilogue"]);
});

test("every edit refers to the original indices, whatever the order of the edits", () => {
  const edits: SceneEdit[] = [
    { action: "insert_after", index: 0, scene: scene("Walk A") },
    { action: "remove", index: 0, scene: null },
    { action: "replace", index: 2, scene: scene("Porch at dusk") },
    { action: "insert_after", index: 0, scene: scene("Walk B") },
    { action: "insert_after", index: 2, scene: scene("Phone call") },
    { action: "remove", index: 3, scene: null },
  ];
  const expected = ["Walk A", "Walk B", "Letter", "Porch at dusk", "Phone call"];
  assert.deepEqual(titles(applyRefinePatch(makePlan(), patch({ sceneEdits: edits }))), expected);
  assert.deepEqual(titles(applyRefinePatch(makePlan(), patch({ sceneEdits: [...edits.slice(1), edits[0]] }))), [
    "Walk B",
    "Walk A",
    ...expected.slice(2),
  ]);
});

test("out-of-range or non-integer indices are rejected", () => {
  const bad: SceneEdit[] = [
    { action: "replace", index: 4, scene: scene("X") },
    { action: "replace", index: -1, scene: scene("X") },
    { action: "remove", index: 4, scene: null },
    { action: "remove", index: -1, scene: null },
    { action: "insert_after", index: -2, scene: scene("X") },
    { action: "insert_after", index: 4, scene: scene("X") },
    { action: "replace", index: 1.5, scene: scene("X") },
  ];
  for (const edit of bad) assert.equal(applyRefinePatch(makePlan(), patch({ sceneEdits: [edit] })), null, JSON.stringify(edit));
});

test("two replace or remove edits for the same scene are rejected", () => {
  const twice = (a: SceneEdit, b: SceneEdit) => applyRefinePatch(makePlan(), patch({ sceneEdits: [a, b] }));
  assert.equal(twice({ action: "replace", index: 1, scene: scene("A") }, { action: "replace", index: 1, scene: scene("B") }), null);
  assert.equal(twice({ action: "replace", index: 1, scene: scene("A") }, { action: "remove", index: 1, scene: null }), null);
  assert.equal(twice({ action: "remove", index: 1, scene: null }, { action: "remove", index: 1, scene: null }), null);
  assert.ok(twice({ action: "replace", index: 1, scene: scene("A") }, { action: "insert_after", index: 1, scene: scene("B") }));
});

test("replace and insert need a scene", () => {
  assert.equal(applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "replace", index: 0, scene: null }] })), null);
  assert.equal(applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "insert_after", index: 0, scene: null }] })), null);
});

test("a scene without shots or a shot without a positive finite duration is rejected", () => {
  assert.equal(applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "replace", index: 0, scene: scene("Empty", []) }] })), null);
  for (const seconds of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const bad = scene("Bad", [shot("Fine"), shot("Bad", { seconds })]);
    assert.equal(applyRefinePatch(makePlan(), patch({ sceneEdits: [{ action: "insert_after", index: 0, scene: bad }] })), null, `${seconds}`);
  }
});

test("removing every scene is rejected", () => {
  const sceneEdits = [0, 1, 2, 3].map((index): SceneEdit => ({ action: "remove", index, scene: null }));
  assert.equal(applyRefinePatch(makePlan(), patch({ sceneEdits })), null);
  assert.deepEqual(
    titles(applyRefinePatch(makePlan(), patch({ sceneEdits: [...sceneEdits, { action: "insert_after", index: 3, scene: scene("Only") }] }))),
    ["Only"],
  );
});

test("the input plan and patch are never mutated and the result shares no references", () => {
  const plan = makePlan();
  const edits = patch({ sceneEdits: [{ action: "replace", index: 0, scene: scene("New") }] });
  const snapshot = structuredClone(edits);
  const result = applyRefinePatch(plan, edits);
  assert.ok(result);
  assert.deepEqual(plan, makePlan());
  assert.deepEqual(edits, snapshot);
  result.scenes[1].shots[0].action = "Changed";
  result.characters[0].name = "Changed";
  assert.deepEqual(plan, makePlan());
});

// --- applyRenames ---

function keeperPlan(): ShotPlan {
  const keeperShot = (action: string, overrides: Partial<Shot> = {}) =>
    shot(action, { characters: ["Keeper"], location: "Keeper's Room", ...overrides });
  return {
    title: "The Keeper",
    logline: "The lonely lighthouse keeper finds a girl on the rocks.",
    intent: "The Keeper learns to trust again.",
    characters: [
      { name: "Keeper", role: "the lonely lighthouse keeper", look: "Oilskin coat", personality: "Wary", voice: "Low" },
      { name: "Girl", role: "Castaway", look: "Wet dress", personality: "Bold", voice: "Bright" },
      { name: "Dispatcher", role: "Radio voice", look: "Unseen", personality: "Calm", voice: "Crackly" },
    ],
    locations: [
      { name: "Keeper's Room", description: "Narrow bed under the lamp; the Keeper's chair by the window." },
      { name: "Kitchen", description: "Tin bowls and a kitchen table." },
    ],
    scenes: [
      {
        title: "The Keeper wakes",
        shots: [
          keeperShot("The Keeper sets the bowl on the table."),
          keeperShot("The Girl sleeps in the Keeper's chair.", {
            characters: ["keeper", "Girl"],
            dialogue: [{ speaker: "KEEPER", line: "Keeper's rules: no lights after ten.", delivery: "Gruff" }],
          }),
        ],
      },
      {
        title: "Kitchen talk",
        shots: [
          shot("The lonely lighthouse keeper pours tea in the Kitchen. Gatekeepers and Keepers are not mentioned.", {
            characters: ["Keeper", "Girl"],
            location: "Kitchen",
            dialogue: [{ speaker: "Girl", line: "Are you the keeper here?", delivery: "Shy" }],
            sound: "Kettle in the Kitchen; kitchen clock ticking",
          }),
        ],
      },
    ],
    reviewNotes: ["Suggestion: keep the Keeper's Room dim."],
  };
}

const keeperShots = (plan: ShotPlan) => plan.scenes.flatMap(({ shots }) => shots);

test("a character rename reaches every name column and every proper-name mention, with its leading the", () => {
  const renamed = applyRenames(keeperPlan(), [{ from: "Keeper", to: "Aswin" }]);
  assert.deepEqual(renamed.characters.map(({ name }) => name), ["Aswin", "Girl", "Dispatcher"]);
  assert.deepEqual(renamed.locations.map(({ name }) => name), ["Aswin's Room", "Kitchen"]);
  const [first, second, third] = keeperShots(renamed);
  assert.equal(first.action, "Aswin sets the bowl on the table.");
  assert.equal(second.action, "The Girl sleeps in Aswin's chair.");
  assert.deepEqual(second.characters, ["Aswin", "Girl"]);
  assert.deepEqual(second.dialogue[0], { speaker: "Aswin", line: "Aswin's rules: no lights after ten.", delivery: "Gruff" });
  assert.equal(first.location, "Aswin's Room");
  assert.deepEqual(third.characters, ["Aswin", "Girl"]);
  assert.equal(renamed.scenes[0].title, "Aswin wakes");
  assert.equal(renamed.intent, "Aswin learns to trust again.");
  assert.equal(renamed.locations[0].description, "Narrow bed under the lamp; Aswin's chair by the window.");
  assert.deepEqual(renamed.reviewNotes, ["Suggestion: keep Aswin's Room dim."]);
});

test("the common noun stays: the lonely lighthouse keeper is not renamed", () => {
  const renamed = applyRenames(keeperPlan(), [{ from: "Keeper", to: "Aswin" }]);
  assert.equal(renamed.logline, "The lonely lighthouse keeper finds a girl on the rocks.");
  assert.equal(renamed.characters[0].role, "the lonely lighthouse keeper");
  const third = keeperShots(renamed)[2];
  assert.equal(third.action, "The lonely lighthouse keeper pours tea in the Kitchen. Gatekeepers and Keepers are not mentioned.");
  assert.equal(third.dialogue[0].line, "Are you the keeper here?");
  assert.equal(renamed.title, "The Keeper", "the film title is never renamed");
});

test("a name written with The matches mid-sentence the too, but never inside a longer phrase", () => {
  const plan = keeperPlan();
  plan.characters[0].name = "The Keeper";
  plan.scenes[0].shots[0].characters = ["The Keeper"];
  plan.scenes[0].shots[0].action = "She hands the lamp to the Keeper. The Keeper's hands shake.";
  plan.logline = "The lonely lighthouse keeper meets the Keeper's match.";
  const renamed = applyRenames(plan, [{ from: "The Keeper", to: "Aswin" }]);
  assert.equal(renamed.characters[0].name, "Aswin");
  assert.deepEqual(renamed.scenes[0].shots[0].characters, ["Aswin"]);
  assert.equal(renamed.scenes[0].shots[0].action, "She hands the lamp to Aswin. Aswin's hands shake.");
  assert.equal(renamed.logline, "The lonely lighthouse keeper meets Aswin's match.");
});

test("a location rename reaches the table, the where column and mentions, keeping the place's the", () => {
  const renamed = applyRenames(keeperPlan(), [{ from: "Kitchen", to: "Galley" }]);
  assert.deepEqual(renamed.locations.map(({ name }) => name), ["Keeper's Room", "Galley"]);
  const third = keeperShots(renamed)[2];
  assert.equal(third.location, "Galley");
  assert.equal(third.action, "The lonely lighthouse keeper pours tea in the Galley. Gatekeepers and Keepers are not mentioned.");
  assert.equal(third.sound, "Kettle in the Galley; kitchen clock ticking");
  assert.equal(renamed.locations[1].description, "Tin bowls and a kitchen table.");
  assert.equal(renamed.scenes[1].title, "Galley talk");
  assert.deepEqual(keeperShots(renamed)[0], keeperShots(keeperPlan())[0]);
});

test("several renames apply at once, longest name first", () => {
  const renamed = applyRenames(keeperPlan(), [
    { from: "Keeper", to: "Aswin" },
    { from: "Keeper's Room", to: "Lamp Room" },
    { from: "Girl", to: "Mira" },
  ]);
  assert.deepEqual(renamed.locations.map(({ name }) => name), ["Lamp Room", "Kitchen"]);
  assert.equal(renamed.reviewNotes[0], "Suggestion: keep the Lamp Room dim.");
  const second = keeperShots(renamed)[1];
  assert.equal(second.action, "Mira sleeps in Aswin's chair.");
  assert.equal(second.location, "Lamp Room");
  assert.deepEqual(second.characters, ["Aswin", "Mira"]);
  assert.equal(renamed.logline, "The lonely lighthouse keeper finds a girl on the rocks.");
});

test("invalid renames are ignored; the board's own spelling is used for a valid one", () => {
  const plan = keeperPlan();
  const ignored = [
    { from: "Lighthouse", to: "Tower" },
    { from: "  ", to: "Nobody" },
    { from: "Girl", to: "   " },
    { from: "Girl", to: "Girl" },
    { from: "Girl", to: "x".repeat(MAX_RENAME_CHARACTERS + 1) },
    { from: "Girl", to: "Dispatcher" },
    { from: "Girl", to: "kitchen" },
  ];
  assert.deepEqual(validRenames(plan, ignored), []);
  assert.deepEqual(applyRenames(plan, ignored), keeperPlan());

  assert.deepEqual(validRenames(plan, [{ from: " keeper ", to: "  Aswin   Rao " }]), [{ from: "Keeper", to: "Aswin Rao", kind: "character" }]);
  const renamed = applyRenames(plan, [{ from: "keeper", to: "Aswin" }]);
  assert.equal(renamed.logline, "The lonely lighthouse keeper finds a girl on the rocks.", "lowercase from never hits prose");
  assert.equal(renamed.characters[0].name, "Aswin");

  assert.deepEqual(
    validRenames(plan, [
      { from: "Girl", to: "Mira" },
      { from: "girl", to: "Ana" },
      { from: "Dispatcher", to: "mira" },
    ]),
    [{ from: "Girl", to: "Mira", kind: "character" }],
  );
});

test("at most MAX_RENAMES renames are applied", () => {
  const plan = keeperPlan();
  plan.characters = Array.from({ length: MAX_RENAMES + 2 }, (_, index) => ({ ...plan.characters[0], name: `Person ${index}` }));
  const renames = plan.characters.map(({ name }, index) => ({ from: name, to: `Renamed ${index}` }));
  assert.equal(validRenames(plan, renames).length, MAX_RENAMES);
  const names = applyRenames(plan, renames).characters.map(({ name }) => name);
  assert.equal(names.filter((name) => name.startsWith("Renamed")).length, MAX_RENAMES);
  assert.deepEqual(names.slice(-2), [`Person ${MAX_RENAMES}`, `Person ${MAX_RENAMES + 1}`]);
});

test("names with regex characters and replacement patterns are taken literally", () => {
  const plan = keeperPlan();
  plan.characters[2].name = "Dr. Mae (Ret.)";
  plan.scenes[0].shots[0].action = "Dr. Mae (Ret.) calls. Dr X Mae (Ret.) does not.";
  const renamed = applyRenames(plan, [{ from: "Dr. Mae (Ret.)", to: "$& Ann $1" }]);
  assert.equal(renamed.characters[2].name, "$& Ann $1");
  assert.equal(renamed.scenes[0].shots[0].action, "$& Ann $1 calls. Dr X Mae (Ret.) does not.");
});

test("renames never mutate the input and the result shares no references", () => {
  const plan = keeperPlan();
  const renames = [{ from: "Keeper", to: "Aswin" }];
  const renamed = applyRenames(plan, renames);
  assert.deepEqual(plan, keeperPlan());
  assert.deepEqual(renames, [{ from: "Keeper", to: "Aswin" }]);
  renamed.scenes[0].shots[0].characters.push("Changed");
  renamed.characters[1].name = "Changed";
  assert.deepEqual(plan, keeperPlan());
  const untouched = applyRenames(plan, []);
  assert.deepEqual(untouched, plan);
  assert.notEqual(untouched.scenes, plan.scenes);
});

test("renameNameColumns fixes old names the model wrote and is safe to apply twice", () => {
  const plan = keeperPlan();
  const renames = validRenames(plan, [{ from: "Keeper", to: "Aswin" }]);
  const once = renameNameColumns(plan, renames);
  assert.deepEqual(once.characters.map(({ name }) => name), ["Aswin", "Girl", "Dispatcher"]);
  assert.deepEqual(keeperShots(once)[1].characters, ["Aswin", "Girl"]);
  assert.equal(keeperShots(once)[1].dialogue[0].speaker, "Aswin");
  assert.equal(keeperShots(once)[0].action, "The Keeper sets the bowl on the table.", "text is left to applyRenames");
  assert.deepEqual(renameNameColumns(once, renames), once);
  assert.deepEqual(plan, keeperPlan());
});

test("a scene the filmmaker emptied by hand doesn't block edits to other scenes", () => {
  const plan = structuredClone(basePlanForEmptySceneTest());
  plan.scenes[1].shots = [];
  const replacement = structuredClone(plan.scenes[0]);
  replacement.title = "Rewritten";
  const result = applyRefinePatch(plan, {
    reply: "",
    changeSummary: [],
    title: null,
    logline: null,
    intent: null,
    characters: null,
    locations: null,
    reviewNotes: null,
    sceneEdits: [{ action: "replace", index: 0, scene: replacement }],
  });
  assert.ok(result);
  assert.equal(result.scenes[0].title, "Rewritten");
  assert.equal(result.scenes[1].shots.length, 0);
  const emptyReplacement = { ...replacement, shots: [] };
  assert.equal(
    applyRefinePatch(plan, {
      reply: "",
      changeSummary: [],
      title: null,
      logline: null,
      intent: null,
      characters: null,
      locations: null,
      reviewNotes: null,
      sceneEdits: [{ action: "replace", index: 0, scene: emptyReplacement }],
    }),
    null,
  );
});

function basePlanForEmptySceneTest() {
  const shot = { seconds: 4, framing: "Wide", camera: "Still", characters: ["Keeper"], location: "Rocks", action: "Waves.", dialogue: [], emotion: "Calm", sound: "Sea" };
  return {
    title: "T",
    logline: "L",
    intent: "I",
    characters: [{ name: "Keeper", role: "r", look: "l", personality: "p", voice: "v" }],
    locations: [{ name: "Rocks", description: "d" }],
    scenes: [
      { title: "One", shots: [shot] },
      { title: "Two", shots: [shot] },
    ],
    reviewNotes: [],
  };
}
