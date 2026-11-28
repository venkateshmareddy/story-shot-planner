import assert from "node:assert/strict";
import { test } from "node:test";
import { type CallModel, type DirectorDeps, type ModelCall, runDirector, SPECIALISTS } from "../src/lib/agents/orchestrator.ts";
import { directorRequest } from "../src/lib/agents/schemas.ts";
import {
  MAX_SPECIALIST_FACTS,
  SPECIALIST_MAX_OUTPUT_TOKENS,
  specialistContext,
  specialistInstructions,
} from "../src/lib/agents/shared.ts";
import type { DecisionRecord, DirectorRequest, SpecialistId } from "../src/lib/agents/types.ts";
import { ANALYSIS_STYLE, DIRECTOR_PERSONA, PLAIN_LANGUAGE, SOURCE_RULES, SOURCE_STORY_RULE } from "../src/lib/server/prompts.ts";
import type { ContextFact, StoryContext } from "../src/lib/story-context.ts";
import { MAX_REFINE_SOURCE_CHARACTERS, type RefineRequest, type ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord, UsageStep } from "../src/lib/usage.ts";
import { decisionsOf, memoryFacts, sectionJson, sectionList, sectionText } from "./model-input.ts";

type Fact = ContextFact;
type Status = "filmmaker" | "approved" | "ai_suggestion";
type SentFact = { category: string; label: string; value: string; status: Status };
type SpecialistInput = {
  message: string;
  recent: string[];
  context?: { facts: SentFact[]; openQuestions: string[] };
  approved?: { collected: string[] };
  decisions: DecisionRecord[];
  source?: string;
  plan: unknown;
};

/** A specialist's Markdown input read back into the parts it is given. */
function readSpecialistInput(input: string): SpecialistInput {
  const openQuestions = sectionList(input, "OPEN QUESTIONS");
  const hasMemory = sectionText(input, "MEMORY — what we know") !== undefined || openQuestions.length > 0;
  const collected = sectionText(input, "COLLECTED") === undefined ? null : sectionList(input, "COLLECTED");
  const source = sectionText(input, "STORY SOURCE");
  return {
    message: sectionText(input, "MESSAGE") ?? "",
    recent: (sectionText(input, "RECENT CHAT") ?? "").split("\n").filter(Boolean),
    ...(hasMemory ? { context: { facts: memoryFacts(input), openQuestions } } : {}),
    ...(collected ? { approved: { collected } } : {}),
    decisions: decisionsOf(input),
    ...(source === undefined ? {} : { source }),
    plan: sectionJson(input, "PLAN (JSON)"),
  };
}

function makePlan(): ShotPlan {
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
    title: "The Letter",
    logline: "A widower finds a letter.",
    intent: "Quiet grief turning to hope.",
    characters: [{ name: "Elias", role: "Lead", look: "Grey cardigan", personality: "Reserved", voice: "Low" }],
    locations: [
      { name: "Kitchen", description: "Morning light" },
      { name: "Porch", description: "Rainy dusk" },
    ],
    scenes: [
      { title: "Morning", shots: [shot(), shot({ action: "Elias looks out of the window.", dialogue: [] })] },
      { title: "Porch", shots: [shot({ location: "Porch", dialogue: [] })] },
    ],
    reviewNotes: [],
  };
}

const user = (category: Fact["category"], label: string, value: string): Fact => ({
  category,
  label,
  value,
  source: "user",
  approved: true,
});
const ai = (category: Fact["category"], label: string, value: string, approved = false): Fact => ({
  category,
  label,
  value,
  source: "ai",
  approved,
});

const CONTEXT: StoryContext = {
  facts: [
    user("concept", "Premise", "A widower finds a letter from his late wife."),
    ai("genre", "Tone", "Melancholic drama", true),
    user("characters", "Main character", "Elias, 70, reserved"),
    ai("visuals", "Camera style", "Slow handheld"),
    user("lighting", "Light", "Low-key, warm practicals"),
    ai("references", "Inspiration", "Still life paintings", true),
    user("sound", "Music", "Solo cello only at the end"),
    ai("dialogue", "Dialogue", "Sparse, whispered"),
    user("format", "Length", "Three minutes"),
    ai("scenes", "Scene plan", "Kitchen then porch"),
    user("production", "Practical limits", "One weekend, two actors"),
    user("locations", "Setting", "A small coastal house"),
    user("delivery", "Final output", "Festival DCP"),
  ],
  unresolved: ["Who sent the letter?", "Is the cello heard by Elias or only by the audience?"],
};

const DECISIONS: DecisionRecord[] = Array.from({ length: 8 }, (_, index) => ({
  status: index % 2 ? "rejected" : "accepted",
  request: `Request ${index + 1}`,
  changes: [`Change ${index + 1}`],
}));

function request(message: string, extra: Partial<DirectorRequest> = {}): DirectorRequest {
  return {
    plan: makePlan(),
    messages: [{ role: "user", text: "Earlier note" }],
    message,
    collected: [{ label: "Sound", detail: "Mostly silence with rain" }],
    ...extra,
  };
}

const usageFor = (step: UsageStep): UsageRecord => ({ step, model: "fake", inputTokens: 1, outputTokens: 1, totalTokens: 2 });

const recommendation = (index: number) => ({
  target: index ? `S01_SH0${index}` : "Overall",
  issue: `Issue ${index}`,
  recommendation: `Recommendation ${index}`,
  rationale: `Rationale ${index}`,
  priority: "medium" as const,
});

function fakeTeam(recommendations = 1) {
  const calls: ModelCall[] = [];
  const refined: RefineRequest[] = [];
  const callModel: CallModel = async (call) => {
    calls.push(call);
    const output =
      call.step === "orchestrator"
        ? { reply: "Team reply", conflicts: [] }
        : {
            summary: `${call.step} summary`,
            recommendations: Array.from({ length: recommendations }, (_, index) => recommendation(index)),
            edits: [],
          };
    return { output, usage: usageFor(call.step) };
  };
  const deps: DirectorDeps = {
    callModel,
    refine: async (input) => {
      refined.push(structuredClone(input));
      return { reply: "Refined.", changeSummary: [], plan: input.plan, changed: false, usage: [usageFor("refine")] };
    },
  };
  const inputOf = (id: SpecialistId) => {
    const call = calls.find(({ step }) => step === id);
    assert.ok(call, `${id} was not called`);
    return readSpecialistInput(call.input);
  };
  return { deps, calls, refined, inputOf };
}

const REVIEW = "Review my film and give me feedback";

test("each specialist receives only the context categories relevant to its discipline", async () => {
  const team = fakeTeam();
  await runDirector(request(REVIEW, { context: CONTEXT }), team.deps);
  for (const definition of Object.values(SPECIALISTS)) {
    const input = team.inputOf(definition.id);
    assert.ok(input.context, definition.id);
    assert.equal(input.approved, undefined, `${definition.id} still gets the flat fallback`);
    const allowed = new Set<string>(definition.contextCategories);
    for (const fact of input.context.facts) assert.ok(allowed.has(fact.category), `${definition.id} got ${fact.category}`);
    const expected = CONTEXT.facts.filter((fact) => allowed.has(fact.category)).length;
    assert.equal(input.context.facts.length, Math.min(expected, MAX_SPECIALIST_FACTS), definition.id);
    assert.ok(!input.context.facts.some((fact) => fact.category === "delivery"));
  }

  const camera = team.inputOf("cinematography-director").context?.facts ?? [];
  const status = (label: string) => camera.find((fact) => fact.label === label)?.status;
  assert.equal(status("Light"), "filmmaker");
  assert.equal(status("Inspiration"), "approved");
  assert.equal(status("Camera style"), "ai_suggestion");
  assert.ok(!camera.some((fact) => fact.category === "sound" || fact.category === "characters"));

  const sound = team.inputOf("sound-director").context?.facts ?? [];
  assert.deepEqual(new Set(sound.map(({ category }) => category)), new Set(["sound", "dialogue", "locations", "genre"]));
  assert.ok(!sound.some((fact) => fact.category === "visuals" || fact.category === "lighting"));

  const story = team.inputOf("story-analyst").context?.facts ?? [];
  assert.ok(story.some((fact) => fact.category === "characters"));
  assert.ok(!story.some((fact) => fact.category === "lighting" || fact.category === "production"));

  const continuity = team.inputOf("continuity-reviewer").context?.facts ?? [];
  assert.ok(continuity.some((fact) => fact.category === "production"));
});

test("constraints come before AI suggestions and facts are capped and clipped", () => {
  const context: StoryContext = {
    facts: [
      ...Array.from({ length: 20 }, (_, index) => ai("visuals", `Idea ${index}`, "x".repeat(600))),
      user("lighting", "Light", "Low-key"),
      ai("references", "Painting", "Hammershøi interiors", true),
    ],
    unresolved: [],
  };
  const { facts } = specialistContext(context, "cinematography-director", SPECIALISTS["cinematography-director"].contextCategories);
  assert.equal(facts.length, MAX_SPECIALIST_FACTS);
  assert.deepEqual(
    facts.slice(0, 2).map(({ label, status }) => [label, status]),
    [
      ["Light", "filmmaker"],
      ["Painting", "approved"],
    ],
  );
  assert.ok(facts.slice(2).every(({ status }) => status === "ai_suggestion"));
  assert.ok(facts.every(({ value }) => value.length <= 300));
});

test("open questions are capped at 4 and ranked by relevance to the discipline", () => {
  const unresolved = ["Who is the antagonist?", "What is the ending?", "Why does Elias wait?", "Where is the house?", "Is the music diegetic or score?", "What year is it?"];
  const sound = specialistContext({ facts: [], unresolved }, "sound-director", SPECIALISTS["sound-director"].contextCategories);
  assert.equal(sound.openQuestions.length, 4);
  assert.equal(sound.openQuestions[0], "Is the music diegetic or score?");
});

test("the last six decisions reach every specialist with rejected ones marked", async () => {
  const team = fakeTeam();
  await runDirector(request(REVIEW, { context: CONTEXT, decisions: DECISIONS }), team.deps);
  for (const id of Object.keys(SPECIALISTS) as SpecialistId[]) {
    const { decisions } = team.inputOf(id);
    assert.deepEqual(decisions, DECISIONS.slice(-6), id);
    assert.deepEqual(
      decisions.filter(({ status }) => status === "rejected").map(({ request: text }) => text),
      ["Request 4", "Request 6", "Request 8"],
    );
  }
});

test("decisions pass through to the plan edit, with or without named scenes", async () => {
  for (const message of ["Rename Elias to Tom", "In scene 2, have a postman deliver the letter"]) {
    const team = fakeTeam();
    const result = await runDirector(request(message, { decisions: DECISIONS }), team.deps);
    assert.equal(result.mode, "refine", message);
    assert.equal(team.calls.length, 0, message);
    assert.equal(team.refined.length, 1, message);
    assert.deepEqual(team.refined[0].decisions, DECISIONS, message);
  }
  const team = fakeTeam();
  await runDirector(request("Rename Elias to Tom"), team.deps);
  assert.ok(!("decisions" in team.refined[0]));
});

test("specialist and synthesis instructions inherit the Creative Director persona and analysis style", async () => {
  const team = fakeTeam();
  await runDirector(request(REVIEW, { context: CONTEXT }), team.deps);
  assert.equal(team.calls.length, 6);
  for (const call of team.calls) {
    for (const part of [SOURCE_RULES, DIRECTOR_PERSONA, PLAIN_LANGUAGE, ANALYSIS_STYLE]) {
      assert.ok(call.instructions.includes(part), `${call.step} lacks ${part.slice(0, 30)}`);
    }
    assert.ok(call.instructions.indexOf(SOURCE_RULES) < call.instructions.indexOf(DIRECTOR_PERSONA), call.step);
  }
  for (const definition of Object.values(SPECIALISTS)) {
    const text = definition.instructions;
    assert.match(text, /never all at once/, definition.id);
    assert.match(text, /Stay strictly in your discipline\. The other experts cover/, definition.id);
    assert.match(text, /rejected decision/, definition.id);
    assert.match(text, /AI suggestions are earlier AI guesses/, definition.id);
    assert.match(text, /MEMORY — what we know and OPEN QUESTIONS/, definition.id);
    assert.match(text, /up to 5/, definition.id);
  }
  assert.match(SPECIALISTS["cinematography-director"].instructions, /depth of field/);
  assert.match(SPECIALISTS["sound-director"].instructions, /Foley/);
  assert.match(SPECIALISTS["editing-director"].instructions, /emotional timing/);
  assert.match(SPECIALISTS["story-analyst"].instructions, /what is at risk/);
  assert.match(SPECIALISTS["continuity-reviewer"].instructions, /props/);
  assert.ok(!SPECIALISTS["sound-director"].instructions.includes("Sound (dialogue clarity"));

  const synthesis = team.calls.find(({ step }) => step === "orchestrator");
  assert.ok(synthesis);
  assert.match(synthesis.instructions, /ONE coherent Creative Director voice/);
  assert.match(synthesis.instructions, /60-150 words/);
  assert.match(synthesis.instructions, /350 words/);
  assert.equal(synthesis.maxOutputTokens, 1_200);
});

test("budgets: every specialist shares one bounded output cap", () => {
  assert.equal(SPECIALIST_MAX_OUTPUT_TOKENS, 2_800);
  const caps = Object.fromEntries(Object.values(SPECIALISTS).map(({ id, maxOutputTokens }) => [id, maxOutputTokens]));
  assert.deepEqual(caps, {
    "story-analyst": 2_800,
    "cinematography-director": 2_800,
    "sound-director": 2_800,
    "editing-director": 2_800,
    "continuity-reviewer": 2_800,
  });
});

test("legacy three-argument instructions still work", () => {
  const text = specialistInstructions("Sound Director", "Sound.", "Edit only sound.");
  assert.ok(text.includes(DIRECTOR_PERSONA) && text.includes(ANALYSIS_STYLE));
  assert.ok(!text.includes("undefined"));
});

test("recommendations are capped at five per specialist", async () => {
  const team = fakeTeam(7);
  const result = await runDirector(request("Make shot 1 a close-up", { context: CONTEXT }), team.deps);
  assert.equal(result.recommendations.length, 5);
  assert.ok(result.recommendations.every(({ specialist }) => specialist === "cinematography-director"));
});

test("synthesis sees established facts only and deeper findings for a focused team", async () => {
  const team = fakeTeam(7);
  await runDirector(request("Better lighting and a softer score", { context: CONTEXT }), team.deps);
  const synthesis = team.calls.find(({ step }) => step === "orchestrator");
  assert.ok(synthesis);
  const established = sectionList(synthesis.input, "ESTABLISHED");
  assert.ok(established.length > 0 && established.length <= 8);
  assert.ok(established.some((line) => line.includes("Three minutes")));
  assert.ok(!established.some((line) => line.includes("Slow handheld") || line.includes("Sparse, whispered")));
  const findings = (sectionText(synthesis.input, "FINDINGS") ?? "").split("\n");
  const disciplines = findings.filter((line) => !line.startsWith("- "));
  assert.deepEqual(
    disciplines.map((line) => line.split(":")[0]),
    ["Camera", "Sound"],
  );
  const points = findings.filter((line) => line.startsWith("- "));
  assert.equal(points.length, 10);
  assert.ok(points.every((line) => /^- medium · \S+ · issue: Issue \d · change: Recommendation \d · why: Rationale \d$/.test(line)));
});

test("without a StoryContext specialists fall back to the flat approved list", async () => {
  for (const extra of [{}, { context: { facts: [], unresolved: [] } }]) {
    const team = fakeTeam();
    await runDirector(request("How should the music work?", extra), team.deps);
    const input = team.inputOf("sound-director");
    assert.equal(input.context, undefined);
    assert.deepEqual(input.approved, { collected: ["Sound: Mostly silence with rain"] });
    assert.deepEqual(input.decisions, []);
  }
});

test("selective invocation is unchanged when context is present", async () => {
  const team = fakeTeam();
  const result = await runDirector(request("Make shot 1 a close-up", { context: CONTEXT, decisions: DECISIONS }), team.deps);
  assert.deepEqual(team.calls.map(({ step }) => step), ["cinematography-director"]);
  assert.deepEqual(result.specialists, ["cinematography-director"]);
  assert.equal(result.reply, "cinematography-director summary");
});

test("fallback reply uses label lines and bullets when synthesis fails", async () => {
  const team = fakeTeam(3);
  const failing: CallModel = async (call) => {
    if (call.step === "orchestrator") throw new Error("down");
    return team.deps.callModel(call);
  };
  const result = await runDirector(request("Better lighting and a softer score"), { ...team.deps, callModel: failing });
  assert.equal(
    result.reply,
    [
      "Camera:\ncinematography-director summary\n- Recommendation 0\n- S01_SH01: Recommendation 1",
      "Sound:\nsound-director summary\n- Recommendation 0\n- S01_SH01: Recommendation 1",
    ].join("\n\n"),
  );
});

test("director request schema accepts context and decisions within limits", () => {
  const base = request(REVIEW, { context: CONTEXT, decisions: DECISIONS });
  assert.ok(directorRequest.safeParse(base).success);
  const tooMany = Array.from({ length: 13 }, () => DECISIONS[0]);
  assert.ok(!directorRequest.safeParse({ ...base, decisions: tooMany }).success);
  assert.ok(!directorRequest.safeParse({ ...base, decisions: [{ ...DECISIONS[0], status: "maybe" }] }).success);
  const badFact = { ...CONTEXT.facts[0], category: "budget" };
  assert.ok(!directorRequest.safeParse({ ...base, context: { ...CONTEXT, facts: [badFact] } }).success);
});

const SOURCE = "Imported story:\nElias finds a letter from his late wife. \"I kept every word,\" he says.";

test("the imported story reaches only the Story and Consistency experts", async () => {
  const team = fakeTeam();
  await runDirector(request(REVIEW, { source: SOURCE }), team.deps);
  for (const id of Object.keys(SPECIALISTS) as SpecialistId[]) {
    const reads = id === "story-analyst" || id === "continuity-reviewer";
    assert.equal(team.inputOf(id).source, reads ? SOURCE : undefined, id);
    assert.equal(SPECIALISTS[id].instructions.includes(SOURCE_STORY_RULE), reads, id);
  }
  const synthesis = team.calls.find(({ step }) => step === "orchestrator");
  assert.ok(synthesis && !synthesis.input.includes("I kept every word"));
  const without = fakeTeam();
  await runDirector(request(REVIEW), without.deps);
  assert.ok(!("source" in without.inputOf("story-analyst")));
});

test("the imported story passes through to the plan edit, with or without named scenes", async () => {
  for (const message of ["Rename Elias to Tom", "In scene 2, have a postman deliver the letter"]) {
    const team = fakeTeam();
    await runDirector(request(message, { source: SOURCE, decisions: DECISIONS }), team.deps);
    assert.equal(team.refined.length, 1, message);
    assert.equal(team.refined[0].source, SOURCE, message);
    assert.deepEqual(team.refined[0].decisions, DECISIONS, message);
  }
  const team = fakeTeam();
  await runDirector(request("Rename Elias to Tom"), team.deps);
  assert.ok(!("source" in team.refined[0]));
});

test("director request schema accepts a source up to the refine limit", () => {
  const base = request(REVIEW);
  const parsed = directorRequest.safeParse({ ...base, source: `  ${SOURCE}  ` });
  assert.ok(parsed.success);
  assert.equal(parsed.data.source, SOURCE);
  assert.ok(directorRequest.safeParse({ ...base, source: "x".repeat(MAX_REFINE_SOURCE_CHARACTERS) }).success);
  assert.ok(!directorRequest.safeParse({ ...base, source: "x".repeat(MAX_REFINE_SOURCE_CHARACTERS + 1) }).success);
  assert.ok(!directorRequest.safeParse({ ...base, source: 42 }).success);
});
