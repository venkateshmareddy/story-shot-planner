import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type OpenAI from "openai";
import { cinematographyDirector } from "../src/lib/agents/cinematography-director.ts";
import { continuityReviewer } from "../src/lib/agents/continuity-reviewer.ts";
import { type CallModel, type ModelCall, runDirector, SPECIALISTS } from "../src/lib/agents/orchestrator.ts";
import { selectSpecialists } from "../src/lib/agents/router.ts";
import { shotId } from "../src/lib/agents/shared.ts";
import type { SpecialistId } from "../src/lib/agents/types.ts";
import { FILM_FORMATS } from "../src/lib/formats.ts";
import { EXTRA_DIRECTION_QUESTION } from "../src/lib/interview.ts";
import { openAIDigestModel } from "../src/lib/server/digest.ts";
import { openAIIdeasModel } from "../src/lib/server/ideas.ts";
import { analyseImage } from "../src/lib/server/image-analysis.ts";
import { createModelCaller } from "../src/lib/server/openai.ts";
import { collectedBeyondContext, runPlan } from "../src/lib/server/plan-generation.ts";
import { composeInstructions, type Stage } from "../src/lib/server/prompts.ts";
import { type StoryContext, toCollected } from "../src/lib/story-context.ts";
import type { PlanOutline, ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord } from "../src/lib/usage.ts";
import { sectionJson, sectionList, sectionText, sectionTitles } from "./model-input.ts";

type Shot = ShotPlan["scenes"][number]["shots"][number];

const STAGES: readonly Stage[] = ["draft", "interview", "plan_outline", "plan_scene", "edit_plan", "edit_scene", "ideas"];
const SHOTS_PER_SCENE = [8, 10, 9, 11, 9, 8, 9];

/** 7 scenes, 64 shots, field lengths like a live plan. Scene 3 changes location mid-scene. */
function largePlan(): ShotPlan {
  return {
    title: "The Last Keeper",
    logline: "A lighthouse keeper finds a girl on the rocks the night the light fails.",
    intent: "Loneliness turning into care, told through weather, light and small gestures.",
    characters: [
      { name: "Keeper", role: "Lead", look: "Old raincoat", personality: "Gruff, careful", voice: "Low" },
      { name: "Girl", role: "Stranger", look: "Soaked red jumper", personality: "Wary", voice: "Quiet" },
      { name: "Fisher", role: "Neighbour", look: "Oilskins", personality: "Warm", voice: "Loud" },
    ],
    locations: [
      { name: "Rocks", description: "Black wet rocks below the tower" },
      { name: "Lamp room", description: "Glass room at the top, brass and soot" },
      { name: "Village", description: "Row of shut cottages along the quay" },
    ],
    scenes: SHOTS_PER_SCENE.map((count, scene) => ({
      title: `Scene ${scene + 1}: the storm grows`,
      shots: Array.from({ length: count }, (_, index): Shot => ({
        seconds: 3 + (index % 4),
        framing: `Medium shot ${scene + 1}.${index + 1}, the Girl on the left third of the frame`,
        camera: index % 2 ? "Slow push-in, 50mm" : "Hold still on a tripod",
        characters: index % 3 === 0 ? ["Keeper", "Girl"] : ["Girl"],
        location: scene === 2 && index === 4 ? "Village" : scene % 2 ? "Lamp room" : "Rocks",
        action: `The Girl climbs the wet stone steps toward the lamp room, step ${index + 1}, while waves break below.`,
        dialogue:
          index % 3 === 0
            ? [{ speaker: index === 6 ? "Fisher" : "Keeper", line: "Mind the steps, they are slick tonight.", delivery: "Quiet" }]
            : [],
        emotion: "Tense but hopeful as the storm builds outside",
        sound: "Waves against the rocks and boots on wet stone",
      })),
    })),
    reviewNotes: [],
  };
}

type ExcerptScene = Record<string, unknown> & { scene: number; shots: (Record<string, unknown> & { id: string })[] };

const excerptOf = (id: SpecialistId, plan: ShotPlan) =>
  (SPECIALISTS[id].buildContext(plan) as { scenes: ExcerptScene[] }).scenes;

const usage = (step: ModelCall["step"]): UsageRecord => ({ step, model: "fake", inputTokens: 1, outputTokens: 1, totalTokens: 2 });

// --- Request settings and prompt caching ---

test("every stage, format, specialist and the synthesis has fixed, date-free instructions", async () => {
  const check = (name: string, instructions: string) =>
    assert.ok(!/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(instructions), `${name} carries a date or time`);
  for (const stage of STAGES) {
    for (const format of FILM_FORMATS) {
      assert.equal(composeInstructions(stage, format), composeInstructions(stage, format));
      check(stage, composeInstructions(stage, format));
    }
  }
  for (const definition of Object.values(SPECIALISTS)) check(definition.id, definition.instructions);

  const calls: ModelCall[] = [];
  const callModel: CallModel = async (call) => {
    calls.push(call);
    const output =
      call.step === "orchestrator"
        ? { reply: "Team reply", conflicts: [] }
        : { summary: `${call.step} summary`, recommendations: [], edits: [] };
    return { output, usage: usage(call.step) };
  };
  const deps = { callModel, refine: async () => assert.fail("no refine expected") };
  const request = { plan: largePlan(), messages: [], message: "Review my film and give me feedback" };
  await runDirector(request, deps);
  await runDirector({ ...request, message: "Review the whole film again" }, deps);
  const byStep = new Map<string, Set<string>>();
  for (const call of calls) byStep.set(call.step, (byStep.get(call.step) ?? new Set()).add(call.instructions));
  assert.equal(byStep.size, 6);
  for (const [step, set] of byStep) assert.equal(set.size, 1, `${step} instructions vary between requests`);
});

function recordingClient(response: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return response;
      },
    },
  };
  return { client, bodies };
}

const COMPLETED = {
  status: "completed",
  incomplete_details: null,
  model: "gpt-test",
  usage: {
    input_tokens: 2_000,
    input_tokens_details: { cached_tokens: 1_536, cache_write_tokens: 0 },
    output_tokens: 100,
    total_tokens: 2_100,
  },
};

const verbosityOf = (body: Record<string, unknown>) => (body.text as { verbosity?: string }).verbosity;

test("createModelCaller turns prompt caching off, sends no cache key and logs cache reads and writes without content", async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => logged.push(args));
  const { client, bodies } = recordingClient({ ...COMPLETED, output_parsed: { shots: [] } });
  const callModel = createModelCaller(client as unknown as OpenAI);
  const schema = z.object({ shots: z.array(z.string()) });
  const scene = composeInstructions("plan_scene", "short_film");
  const input = JSON.stringify({ story: "SECRET STORY", scene: 1 });
  const first = await callModel({
    step: "plan",
    stage: "plan_scene",
    instructions: scene,
    input,
    schema,
    maxOutputTokens: 10,
    signal: new AbortController().signal,
  });

  const [body] = bodies;
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
  assert.ok(!("prompt_cache_key" in body));
  assert.ok(!("prompt_cache_retention" in body));
  assert.ok(!("reasoning" in body));
  assert.equal(body.input, input, "no content part, so no breakpoint");
  assert.equal(body.instructions, scene);
  assert.equal(body.store, false);
  assert.equal(verbosityOf(body), "low");
  assert.equal(first.usage.cachedTokens, 1_536);
  const [label, line] = logged[0] as [string, { cachedTokens: number; cacheWriteTokens: number; stage: string }];
  assert.equal(label, "Model usage");
  assert.equal(line.cachedTokens, 1_536);
  assert.equal(line.cacheWriteTokens, 0);
  assert.equal(line.stage, "plan_scene");
  assert.ok(!JSON.stringify(logged).includes("SECRET STORY"));
});

test("the ideas, digest and image adapters turn prompt caching off and apply their stage's verbosity", async (t) => {
  t.mock.method(console, "info", () => {});
  const signal = new AbortController().signal;

  const ideas = recordingClient({ ...COMPLETED, output_parsed: { question: "", options: [], concepts: [] } });
  const instructions = composeInstructions("ideas", "short_film");
  await openAIIdeasModel(ideas.client as never)({ instructions, input: "{}", maxOutputTokens: 10, signal });

  const digest = recordingClient({ ...COMPLETED, output_parsed: {} });
  await openAIDigestModel(digest.client as never)({ instructions: "Digest.", input: "{}", maxOutputTokens: 10, signal });

  const analysis = { summary: "A lamp.", composition: "", lighting: "", cameraAngle: "", colour: "", environment: "", mood: "", shotIdeas: "" };
  const image = recordingClient({ ...COMPLETED, output_parsed: analysis });
  await analyseImage(image.client as never, new Uint8Array([137, 80, 78, 71]), "image/png", "Lamp");

  for (const [name, bodies, verbosity] of [
    ["ideas", ideas.bodies, "low"],
    ["digest", digest.bodies, "low"],
    ["image", image.bodies, "medium"],
  ] as const) {
    assert.equal(bodies.length, 1, name);
    assert.deepEqual(bodies[0].prompt_cache_options, { mode: "explicit" }, name);
    assert.ok(!("prompt_cache_key" in bodies[0]), name);
    assert.equal(verbosityOf(bodies[0]), verbosity, name);
  }
  assert.equal((ideas.bodies[0].text as { format: { name: string } }).format.name, "story_ideas");
  assert.equal((digest.bodies[0].text as { format: { name: string } }).format.name, "story_digest_part");
  assert.equal((image.bodies[0].text as { format: { name: string } }).format.name, "image_analysis");
});

// --- Plan scenes read less ---

function outline(): PlanOutline {
  return {
    title: "The Last Keeper",
    logline: "A keeper relights a dying lighthouse.",
    intent: "Loneliness turning to resolve.",
    characters: [{ name: "Mara", role: "Keeper", look: "Oilskin coat", personality: "Stubborn", voice: "Low" }],
    locations: [{ name: "Lighthouse", description: "Storm-battered tower" }],
    scenes: [1, 2].map((scene) => ({
      title: `Scene ${scene}`,
      summary: `What happens in scene ${scene}.`,
      location: "Lighthouse",
      characters: ["Mara"],
      seconds: 30,
    })),
    reviewNotes: [],
  };
}

const CONTEXT: StoryContext = {
  facts: [
    { category: "characters", label: "Main character", value: "Mara, the keeper", source: "user", approved: true, answer: 0 },
    { category: "genre", label: "Genre", value: "Drama", source: "ai", approved: false },
  ],
  unresolved: ["Why does the light fail?"],
};

test("scene calls send story, collected facts, extra directions and the outline, not the raw answers", async () => {
  const calls: ModelCall[] = [];
  const callModel: CallModel = async (call) => {
    calls.push(call);
    const scene = sectionText(call.input, "SCENE TO WRITE");
    const shots = [{ seconds: 4, framing: "Wide", camera: "Static", characters: ["Mara"], location: "Lighthouse", action: `Shot ${scene}`, dialogue: [], emotion: "Calm", sound: "Wind" }];
    return { output: scene === undefined ? outline() : { shots }, usage: usage("plan") };
  };
  const collected = toCollected(CONTEXT, 80);
  const answers = [
    { question: "Who is it about?", answer: "Mara, the keeper." },
    { question: EXTRA_DIRECTION_QUESTION, answer: "Shoot it all handheld." },
  ];
  await runPlan({ story: "The Last Keeper", answers, collected, context: CONTEXT }, callModel);

  const [outlineCall, ...sceneCalls] = calls;
  const outlineInput = outlineCall.input;
  assert.deepEqual(sectionTitles(outlineInput), ["STORY", "ANSWERS", "DIRECTIONS", "MEMORY — what we know", "OPEN QUESTIONS"]);
  assert.equal(sectionText(outlineInput, "ANSWERS"), "Q1: Who is it about?\nA1: Mara, the keeper.");
  assert.deepEqual(sectionList(outlineInput, "DIRECTIONS"), ["Shoot it all handheld."]);
  assert.equal(
    sectionText(outlineInput, "MEMORY — what we know"),
    "From the filmmaker:\n- characters · Main character: Mara, the keeper\nAI suggestions:\n- genre · Genre: Drama",
  );
  assert.deepEqual(sectionList(outlineInput, "OPEN QUESTIONS"), ["Why does the light fail?"]);
  assert.ok(!outlineInput.includes("COLLECTED"), "collected repeats the context facts");

  assert.equal(sceneCalls.length, 2);
  for (const call of sceneCalls) {
    const payload = call.input;
    assert.deepEqual(sectionTitles(payload), ["STORY", "COLLECTED", "DIRECTIONS", "OUTLINE (JSON)", "SCENE TO WRITE"]);
    assert.deepEqual(
      sectionList(payload, "COLLECTED"),
      collected.map(({ label, detail }) => `${label}: ${detail}`),
    );
    assert.deepEqual(sectionList(payload, "DIRECTIONS"), ["Shoot it all handheld."]);
    assert.ok(!call.input.includes("Who is it about?"));
  }
  const prompt = composeInstructions("plan_scene", "short_film");
  assert.ok(prompt.includes("directions and the outline are binding: never contradict them"));
  assert.ok(prompt.includes("Collected details not marked (AI suggestion)"));
});

test("the outline keeps collected details the context does not state", () => {
  const extra = { label: "Tone", detail: "Bleak, then hopeful" };
  assert.deepEqual(collectedBeyondContext([...toCollected(CONTEXT, 80), extra], CONTEXT), [extra]);
  assert.deepEqual(collectedBeyondContext([extra], { facts: [], unresolved: [] }), [extra]);
  assert.deepEqual(collectedBeyondContext([extra], undefined), [extra]);
});

// --- Experts read less ---

const FIELD_EDITS: Record<SpecialistId, { message: string; field: keyof Shot; value: string; expected: Shot[keyof Shot] }> = {
  "story-analyst": { message: "What is the protagonist's motivation?", field: "action", value: "The Girl stops.", expected: "The Girl stops." },
  "cinematography-director": { message: "Make shot 3 a close-up", field: "framing", value: "Close-up", expected: "Close-up" },
  "sound-director": { message: "Add rain ambience and quiet music", field: "sound", value: "Only rain", expected: "Only rain" },
  "editing-director": { message: "Tighten the pacing of the film", field: "seconds", value: "2.5", expected: 2.5 },
  "continuity-reviewer": { message: "Is the timeline consistent?", field: "location", value: "Village", expected: "Village" },
};

for (const id of Object.keys(FIELD_EDITS) as SpecialistId[]) {
  test(`${id}: an edit aimed at a shot in the excerpt changes that shot, and only it, in the full plan`, async () => {
    const { message, field, value, expected } = FIELD_EDITS[id];
    assert.deepEqual(selectSpecialists(message), [id]);
    const plan = largePlan();
    let target = "";
    const callModel: CallModel = async (call) => {
      const { scenes } = sectionJson<{ scenes: ExcerptScene[] }>(call.input, "PLAN (JSON)") ?? { scenes: [] };
      const sceneIndex = scenes.length - 2;
      const shotIndex = scenes[sceneIndex].shots.length - 2;
      target = scenes[sceneIndex].shots[shotIndex].id;
      const edit = { scene: scenes[sceneIndex].scene, shot: shotIndex + 1, field, value };
      return { output: { summary: "ok", recommendations: [], edits: [edit] }, usage: usage(call.step) };
    };
    const result = await runDirector({ plan, messages: [], message }, { callModel, refine: async () => assert.fail() });

    const sceneIndex = SHOTS_PER_SCENE.length - 2;
    const shotIndex = SHOTS_PER_SCENE[sceneIndex] - 2;
    assert.equal(target, shotId(sceneIndex, shotIndex));
    const want = structuredClone(plan);
    (want.scenes[sceneIndex].shots[shotIndex] as Record<string, unknown>)[field] = expected;
    assert.deepEqual(result.plan, want);
    assert.deepEqual(result.changeSummary.length, 1);
  });
}

test("every excerpt keeps each scene and shot in plan order with matching ids and the specialist's own fields", () => {
  const plan = largePlan();
  for (const definition of Object.values(SPECIALISTS)) {
    const scenes = excerptOf(definition.id, plan);
    assert.equal(scenes.length, plan.scenes.length, definition.id);
    scenes.forEach((scene, sceneIndex) => {
      assert.equal(scene.scene, sceneIndex + 1);
      assert.equal(scene.title, plan.scenes[sceneIndex].title);
      assert.deepEqual(
        scene.shots.map(({ id }) => id),
        plan.scenes[sceneIndex].shots.map((_, shotIndex) => shotId(sceneIndex, shotIndex)),
        definition.id,
      );
      scene.shots.forEach((shot, shotIndex) => {
        const full = plan.scenes[sceneIndex].shots[shotIndex];
        for (const field of definition.fields) {
          if (field in full) assert.deepEqual(shot[field], full[field as keyof Shot], `${definition.id} ${shot.id} ${field}`);
        }
      });
    });
    assert.ok(JSON.stringify(scenes).length < JSON.stringify(plan.scenes).length, definition.id);
  }
});

test("a context value shared by every shot of a scene is stated once on the scene; own fields stay on each shot", () => {
  const plan = largePlan();
  const camera = excerptOf("cinematography-director", plan);
  assert.equal(camera[0].location, "Rocks");
  assert.equal(camera[0].emotion, "Tense but hopeful as the storm builds outside");
  assert.ok(camera[0].shots.every((shot) => !("location" in shot) && "framing" in shot && "camera" in shot));
  assert.ok(!("location" in camera[2]), "scene 3 changes location");
  assert.equal(camera[2].shots[4].location, "Village");
  assert.ok(!("characters" in camera[0]), "who is on screen varies");

  const continuity = excerptOf("continuity-reviewer", plan);
  assert.ok(continuity.every((scene) => !("location" in scene) && scene.shots.every((shot) => "location" in shot)));
});

test("excerpts drop empty context and keep only the dialogue facts each discipline uses", () => {
  const plan = largePlan();
  const story = excerptOf("story-analyst", plan)[0].shots;
  assert.deepEqual(story[0].dialogue, ["Keeper: Mind the steps, they are slick tonight."]);
  assert.ok(!("dialogue" in story[1]));

  const sound = excerptOf("sound-director", plan)[0].shots;
  assert.deepEqual(sound[0].dialogue, ["Keeper (Quiet): Mind the steps, they are slick tonight."]);

  const editing = excerptOf("editing-director", plan)[0];
  assert.equal(editing.sceneSeconds, plan.scenes[0].shots.reduce((total, { seconds }) => total + seconds, 0));
  assert.equal(editing.shots[0].spokenWords, 7);
  assert.ok(!("spokenWords" in editing.shots[1]));

  const continuity = excerptOf("continuity-reviewer", plan)[0].shots;
  assert.ok(!("unlistedSpeakers" in continuity[0]), "the Keeper speaks and is listed");
  assert.deepEqual(continuity[6].unlistedSpeakers, ["Fisher"]);
  assert.match(continuityReviewer.instructions, /unlistedSpeakers/);
  assert.match(cinematographyDirector.instructions, /a shot field given on the scene applies to all its shots/);
});

test("specialist input puts the plan first and the new message last", async () => {
  const inputs: string[] = [];
  const callModel: CallModel = async (call) => {
    if (call.step !== "orchestrator") inputs.push(call.input);
    const output =
      call.step === "orchestrator" ? { reply: "ok", conflicts: [] } : { summary: "ok", recommendations: [], edits: [] };
    return { output, usage: usage(call.step) };
  };
  await runDirector(
    { plan: largePlan(), messages: [{ role: "user", text: "Earlier" }], message: "Review my film", source: "Source text" },
    { callModel, refine: async () => assert.fail() },
  );
  assert.equal(inputs.length, 5);
  for (const input of inputs) {
    const titles = sectionTitles(input);
    assert.equal(titles[0], "PLAN (JSON)");
    assert.equal(titles.at(-1), "MESSAGE");
  }
});
