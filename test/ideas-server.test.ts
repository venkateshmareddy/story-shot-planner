import assert from "node:assert/strict";
import { test } from "node:test";
import { zodTextFormat } from "openai/helpers/zod";
import { POST } from "../src/app/api/story/ideas/route.ts";
import { FILM_FORMATS } from "../src/lib/formats.ts";
import {
  type IdeaExchange,
  type IdeasRequest,
  MAX_AVOID,
  MAX_COMBINE,
  MAX_CONCEPTS,
  type StoryConcept,
  SURPRISE_ME,
} from "../src/lib/ideas.ts";
import { STORY_MODEL } from "../src/lib/models.ts";
import {
  CONCEPT_FIELD_MAX,
  conceptSimilarity,
  DUPLICATE_SIMILARITY,
  IDEAS_GENERATE_MAX_OUTPUT_TOKENS,
  IDEAS_INCOMPLETE_MESSAGE,
  IDEAS_NOT_ENOUGH_MESSAGE,
  IDEAS_SINGLE_MAX_OUTPUT_TOKENS,
  IdeasError,
  type IdeasModelCall,
  type IdeasModelOutput,
  ideasModelOutput,
  ideasRequest,
  openAIIdeasModel,
  runIdeas,
} from "../src/lib/server/ideas.ts";
import {
  ANALYSIS_STYLE,
  composeInstructions,
  DIRECTOR_PERSONA,
  DISCOVERY_STYLE,
  PLAIN_LANGUAGE,
  SOURCE_RULES,
  SUGGESTED_CONCEPT_RULE,
} from "../src/lib/server/prompts.ts";
import { SUGGESTED_CONCEPT_MARKER } from "../src/lib/source-text.ts";
import type { UsageRecord } from "../src/lib/usage.ts";

type Draft = Omit<StoryConcept, "id">;

const IDEAS: Draft[] = [
  {
    title: "Salt Letters",
    genre: "Coastal drama",
    premise: "A fisherwoman in a dying harbour town secretly delivers love letters for strangers who cannot write.",
    mainCharacter: "Ines, 60, wants to keep her late husband's boat afloat.",
    conflict: "The harbour master threatens to seize the boat over unpaid fees.",
    emotionalHook: "Quiet tenderness between people too proud to ask for help.",
    plotDirection: "One letter turns out to be addressed to Ines herself.",
    cinematicAppeal: "Grey sea light, creaking rope and handwriting in close-up.",
  },
  {
    title: "Night Shift Static",
    genre: "Psychological thriller",
    premise: "A hospital radio operator starts hearing calls from a ward that closed twenty years ago.",
    mainCharacter: "Dev wants to prove he is not losing his mind.",
    conflict: "Everyone he tells dismisses him as exhausted.",
    emotionalHook: "Dread mixed with grief for patients nobody remembered.",
    plotDirection: "He follows the static into the sealed wing.",
    cinematicAppeal: "Flickering fluorescent corridors and layered radio hiss.",
  },
  {
    title: "Paper Crown",
    genre: "Comedy",
    premise: "Two rival grandmothers compete to be crowned queen of their village's pumpkin festival.",
    mainCharacter: "Rosa wants one public win before she moves into care.",
    conflict: "Her rival is her oldest friend, who needs the prize money.",
    emotionalHook: "Laughter that turns into an honest goodbye.",
    plotDirection: "Sabotage escalates until they team up.",
    cinematicAppeal: "Bright autumn colour and a brass band that never stays in tune.",
  },
  {
    title: "Underpass",
    genre: "Experimental dance film",
    premise: "A skateboarder maps her grief by tracing the echoes of an underpass at dawn.",
    mainCharacter: "Kit wants to finish the trick her brother never landed.",
    conflict: "The council is about to fill the underpass with concrete.",
    emotionalHook: "Movement standing in for words she cannot say.",
    plotDirection: "Her last run becomes a performance for the demolition crew.",
    cinematicAppeal: "Wheel rhythms on concrete become the soundtrack.",
  },
  {
    title: "The Weather Clerk",
    genre: "Magical realism",
    premise: "A civil servant who files the city's weather forms realises his stamps decide tomorrow's sky.",
    mainCharacter: "Otto wants a single sunny day for his daughter's wedding.",
    conflict: "The forms are audited and every change is traced to him.",
    emotionalHook: "A father bending the rules out of love.",
    plotDirection: "He forges one last form and accepts the consequences.",
    cinematicAppeal: "Rain on office windows switching to sunlight mid-shot.",
  },
  {
    title: "Last Bus to Varna",
    genre: "Road movie",
    premise: "A teenage interpreter rides an overnight bus with a deported stranger whose story she must translate.",
    mainCharacter: "Mira wants to get home before her exam.",
    conflict: "The stranger's account contradicts the official papers.",
    emotionalHook: "Two strangers deciding whether to trust each other.",
    plotDirection: "At the border she chooses which version to translate.",
    cinematicAppeal: "Headlights, sleeping passengers and two languages in the dark.",
  },
];

const USAGE: UsageRecord = { step: "ideas", model: STORY_MODEL, inputTokens: 700, outputTokens: 900, totalTokens: 1_600 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const concept = (index: number, id = `c${index}`): StoryConcept => ({ id, ...IDEAS[index] });
const output = (concepts: Draft[], question = "", options: string[] = []): IdeasModelOutput => ({ question, options, concepts });

function fakeModel(result: IdeasModelOutput | unknown, calls: IdeasModelCall[] = []) {
  return async (call: IdeasModelCall) => {
    calls.push(call);
    return { output: result, usage: USAGE };
  };
}

const generate = (direction: string, answers: IdeaExchange[] = []) =>
  ({ mode: "generate", direction, answers, avoid: [] }) satisfies IdeasRequest;

async function rejectsWith(promise: Promise<unknown>, message: string, reason: IdeasError["reason"]) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof IdeasError);
    assert.equal(error.message, message);
    assert.equal(error.reason, reason);
    assert.deepEqual(error.usage, USAGE);
    return true;
  });
}

const inputOf = (call: IdeasModelCall) => JSON.parse(call.input) as Record<string, unknown>;

test("request schema validates every mode and rejects malformed or oversized requests", () => {
  const valid: unknown[] = [
    generate("A mystery"),
    { mode: "another", direction: SURPRISE_ME, answers: [], avoid: [{ title: "Salt Letters", premise: IDEAS[0].premise }] },
    { mode: "refine", concept: concept(0), change: "Make it a comedy." },
    { mode: "combine", concepts: [concept(0), concept(1)], note: "" },
  ];
  for (const request of valid) assert.ok(ideasRequest.safeParse(request).success, JSON.stringify(request).slice(0, 40));

  const trimmed = ideasRequest.parse({ mode: "generate", direction: "  ghosts  ", answers: [], avoid: [] });
  assert.equal(trimmed.mode === "generate" && trimmed.direction, "ghosts");

  const exchange = { question: "Which feeling?", answer: "Hope" };
  const invalid: unknown[] = [
    { mode: "brainstorm", direction: "x", answers: [], avoid: [] },
    { direction: "x", answers: [], avoid: [] },
    { mode: "generate", direction: "x", answers: [exchange, exchange, exchange], avoid: [] },
    { mode: "generate", direction: "x".repeat(301), answers: [], avoid: [] },
    { mode: "generate", direction: "x", answers: [{ question: "q".repeat(501), answer: "a" }], avoid: [] },
    { mode: "generate", direction: "x", answers: [{ question: "q", answer: "a".repeat(1_001) }], avoid: [] },
    { mode: "generate", direction: "x", answers: [], avoid: Array.from({ length: MAX_AVOID + 1 }, () => ({ title: "t", premise: "p" })) },
    { mode: "refine", concept: concept(0), change: "   " },
    { mode: "refine", concept: concept(0), change: "c".repeat(1_001) },
    { mode: "refine", concept: { ...concept(0), premise: "p".repeat(CONCEPT_FIELD_MAX.premise + 1) }, change: "c" },
    { mode: "refine", concept: { ...concept(0), title: " " }, change: "c" },
    { mode: "combine", concepts: [concept(0)], note: "" },
    { mode: "combine", concepts: Array.from({ length: MAX_COMBINE + 1 }, (_, i) => concept(i)), note: "" },
    { mode: "combine", concepts: [concept(0), concept(1)], note: "n".repeat(501) },
  ];
  for (const request of invalid) assert.ok(!ideasRequest.safeParse(request).success, JSON.stringify(request).slice(0, 80));
});

test("model output schema is flat, with no root union", () => {
  const schema = zodTextFormat(ideasModelOutput, "story_ideas").schema as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.ok(!("anyOf" in schema) && !("oneOf" in schema));
  assert.deepEqual(Object.keys(schema.properties as object).sort(), ["concepts", "options", "question"]);
});

test("generate returns 3–5 cleaned concepts with fresh ids, capped at MAX_CONCEPTS", async () => {
  const calls: IdeasModelCall[] = [];
  const messy = { ...IDEAS[0], title: ' "Salt Letters" ', premise: `  ${IDEAS[0].premise}\n\u0007 ` };
  const missingCore = { ...IDEAS[5], title: "Broken Idea", premise: "A clockmaker rebuilds time.", conflict: "   " };
  const result = await runIdeas(generate("Something human"), fakeModel(output([messy, missingCore, ...IDEAS.slice(1)]), calls));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxOutputTokens, IDEAS_GENERATE_MAX_OUTPUT_TOKENS);
  assert.equal(result.question, null);
  assert.equal(result.concepts.length, MAX_CONCEPTS);
  assert.ok(result.concepts.every((item) => UUID.test(item.id)));
  assert.equal(new Set(result.concepts.map((item) => item.id)).size, result.concepts.length);
  assert.equal(result.concepts[0].title, "Salt Letters");
  assert.equal(result.concepts[0].premise, IDEAS[0].premise);
  assert.ok(!result.concepts.some((item) => item.title === "Broken Idea"), "concept with an empty core field is dropped");
  assert.ok(!result.concepts.some((item) => item.title === IDEAS[5].title), "capped at MAX_CONCEPTS");

  const clipped = await runIdeas(
    generate("x"),
    fakeModel(output([{ ...IDEAS[0], premise: "word ".repeat(400) }, IDEAS[1], IDEAS[2]])),
  );
  assert.ok(clipped.concepts[0].premise.length <= CONCEPT_FIELD_MAX.premise);
  assert.ok(ideasRequest.safeParse({ mode: "refine", concept: clipped.concepts[0], change: "c" }).success, "output round-trips as input");
});

test("a vague direction may return one follow-up question instead of concepts", async () => {
  const options = ["Hope", " hope ", "Fear", "Wonder", "Anger", "Grief", "Joy"];
  const calls: IdeasModelCall[] = [];
  const result = await runIdeas(
    generate("A theme or feeling"),
    fakeModel(output(IDEAS.slice(0, 3), "Which feeling should the story leave people with?", options), calls),
  );
  assert.equal(inputOf(calls[0]).questionAllowed, true);
  assert.deepEqual(result.question, {
    text: "Which feeling should the story leave people with?",
    options: ["Hope", "Fear", "Wonder", "Anger", "Grief"],
  });
  assert.deepEqual(result.concepts, []);
  assert.deepEqual(result.usage, USAGE);
});

test("Surprise me and a full set of answers force concepts and tell the model so", async () => {
  const answers = [
    { question: "Which genre?", answer: "Horror" },
    { question: "Where?", answer: "A lighthouse" },
  ];
  for (const request of [generate(SURPRISE_ME), generate(` ${SURPRISE_ME.toLowerCase()} `), generate("Something", answers)]) {
    const calls: IdeasModelCall[] = [];
    const result = await runIdeas(
      ideasRequest.parse(request),
      fakeModel(output(IDEAS.slice(0, 3), "What genre do you like?", ["A", "B", "C"]), calls),
    );
    assert.equal(inputOf(calls[0]).questionAllowed, false);
    assert.equal(result.question, null);
    assert.equal(result.concepts.length, 3);
  }
});

test("the filmmaker's direction and answers reach the model with the ideas instructions", async () => {
  const calls: IdeasModelCall[] = [];
  const request = generate("A lighthouse keeper's loneliness", [{ question: "Which tone?", answer: "Bittersweet, a little funny" }]);
  await runIdeas(request, fakeModel(output(IDEAS.slice(0, 3)), calls));
  const input = inputOf(calls[0]);
  assert.equal(input.mode, "generate");
  assert.equal(input.direction, "A lighthouse keeper's loneliness");
  assert.deepEqual(input.answers, request.answers);
  assert.equal(input.questionAllowed, true);
  assert.equal(calls[0].instructions, composeInstructions("ideas", "short_film"));
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("near-duplicates of avoid and of each other are dropped", async () => {
  const lightVariant = {
    ...IDEAS[1],
    title: "Night Shift Signals",
    premise: "A hospital radio operator begins hearing calls from a ward that closed twenty years ago.",
  };
  const sameTitle = { ...IDEAS[3], title: "the  paper crown!" };
  assert.ok(conceptSimilarity(lightVariant, IDEAS[1]) >= DUPLICATE_SIMILARITY);
  assert.ok(conceptSimilarity(IDEAS[0], IDEAS[1]) < DUPLICATE_SIMILARITY);

  const avoid = [{ title: IDEAS[0].title, premise: IDEAS[0].premise }];
  const result = await runIdeas(
    { mode: "generate", direction: SURPRISE_ME, answers: [], avoid },
    fakeModel(output([IDEAS[0], IDEAS[1], lightVariant, IDEAS[2], sameTitle, IDEAS[4]])),
  );
  assert.deepEqual(
    result.concepts.map((item) => item.title),
    [IDEAS[1].title, IDEAS[2].title, IDEAS[4].title],
  );
});

test("fewer than MIN_CONCEPTS distinct ideas is an error carrying the call's usage", async () => {
  const duplicate = { ...IDEAS[0], title: "Salt Letters Again" };
  await rejectsWith(
    runIdeas(generate(SURPRISE_ME), fakeModel(output([IDEAS[0], duplicate, IDEAS[1]]))),
    IDEAS_NOT_ENOUGH_MESSAGE,
    "not_enough",
  );
  await rejectsWith(runIdeas(generate("x"), fakeModel(output([]))), IDEAS_NOT_ENOUGH_MESSAGE, "not_enough");
  await rejectsWith(runIdeas(generate("x"), fakeModel({ concepts: "nope" })), IDEAS_INCOMPLETE_MESSAGE, "incomplete");
});

test("another returns exactly one concept that is new against avoid", async () => {
  const calls: IdeasModelCall[] = [];
  const avoid = IDEAS.slice(0, 2).map(({ title, premise }) => ({ title, premise }));
  const request: IdeasRequest = { mode: "another", direction: "Ghosts", answers: [], avoid };
  const result = await runIdeas(request, fakeModel(output([IDEAS[1], IDEAS[2], IDEAS[3]], "Ignored?", ["a"]), calls));
  assert.equal(calls[0].maxOutputTokens, IDEAS_SINGLE_MAX_OUTPUT_TOKENS);
  assert.equal(inputOf(calls[0]).questionAllowed, false);
  assert.deepEqual(inputOf(calls[0]).avoid, avoid);
  assert.equal(result.question, null);
  assert.equal(result.concepts.length, 1);
  assert.equal(result.concepts[0].title, IDEAS[2].title);

  await rejectsWith(
    runIdeas(request, fakeModel(output([IDEAS[0], IDEAS[1]]))),
    "I couldn't come up with an idea different enough from the ones you've seen. Try again.",
    "no_valid_concept",
  );
});

test("refine sends the concept and change and returns one reworked concept", async () => {
  const calls: IdeasModelCall[] = [];
  const original = concept(0, "keep-me");
  const reworked = { ...IDEAS[0], genre: "Coastal comedy", emotionalHook: "Laughing at pride until it cracks." };
  const result = await runIdeas({ mode: "refine", concept: original, change: "Make it funnier." }, fakeModel(output([reworked]), calls));
  const input = inputOf(calls[0]);
  assert.equal(input.change, "Make it funnier.");
  assert.deepEqual(input.concept, IDEAS[0]);
  assert.equal(calls[0].maxOutputTokens, IDEAS_SINGLE_MAX_OUTPUT_TOKENS);
  assert.equal(result.concepts.length, 1);
  assert.equal(result.concepts[0].genre, "Coastal comedy");
  assert.ok(UUID.test(result.concepts[0].id));

  await rejectsWith(
    runIdeas({ mode: "refine", concept: original, change: "Make it funnier." }, fakeModel(output([{ ...IDEAS[0], title: " SALT  letters " }]))),
    "I couldn't rework this idea. Try again or describe the change differently.",
    "no_valid_concept",
  );
});

test("combine sends the selected concepts and note and returns one new concept", async () => {
  const calls: IdeasModelCall[] = [];
  const merged: Draft = {
    title: "Static at Low Tide",
    genre: "Coastal ghost story",
    premise: "A lighthouse radio picks up voices from boats lost decades ago, and an old fisherwoman answers them.",
    mainCharacter: "Ines wants to hear her husband one more time.",
    conflict: "The voices ask her to steer living boats onto the rocks.",
    emotionalHook: "Longing that becomes dangerous.",
    plotDirection: "She must choose between the dead and the town.",
    cinematicAppeal: "Radio hiss over black water and a sweeping beam.",
  };
  const result = await runIdeas(
    { mode: "combine", concepts: [concept(0), concept(1)], note: "Keep the sea." },
    fakeModel(output([IDEAS[0], merged]), calls),
  );
  const input = inputOf(calls[0]);
  assert.deepEqual(input.concepts, [IDEAS[0], IDEAS[1]]);
  assert.equal(input.note, "Keep the sea.");
  assert.equal(result.concepts.length, 1);
  assert.equal(result.concepts[0].title, merged.title, "a copy of a source concept is not a combination");

  await rejectsWith(
    runIdeas({ mode: "combine", concepts: [concept(0), concept(1)], note: "" }, fakeModel(output([IDEAS[1]]))),
    "I couldn't combine these ideas into a new one. Try again or pick different ideas.",
    "no_valid_concept",
  );
});

test("usage is the 'ideas' step from the real response usage, and incomplete responses fail with it", async () => {
  const requests: Record<string, unknown>[] = [];
  const response = (status: string, parsed: IdeasModelOutput | null) => ({
    status,
    output_parsed: parsed,
    model: "some-snapshot",
    usage: { input_tokens: 1_234, output_tokens: 567, total_tokens: 1_801 },
  });
  let next = response("completed", output(IDEAS.slice(0, 3)));
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>) => {
        requests.push(body);
        return next;
      },
    },
  } as unknown as Parameters<typeof openAIIdeasModel>[0];

  const result = await runIdeas(generate(SURPRISE_ME), openAIIdeasModel(client));
  const expected: UsageRecord = { step: "ideas", model: "some-snapshot", inputTokens: 1_234, outputTokens: 567, totalTokens: 1_801 };
  assert.deepEqual(result.usage, expected);
  assert.equal(requests[0].model, STORY_MODEL);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].instructions, composeInstructions("ideas", "short_film"));
  assert.equal(requests[0].max_output_tokens, IDEAS_GENERATE_MAX_OUTPUT_TOKENS);
  assert.equal(JSON.parse(requests[0].input as string).direction, SURPRISE_ME);
  assert.equal((requests[0].text as { format: { name: string } }).format.name, "story_ideas");

  next = response("incomplete", null);
  await assert.rejects(runIdeas(generate(SURPRISE_ME), openAIIdeasModel(client)), (error: unknown) => {
    assert.ok(error instanceof IdeasError);
    assert.equal(error.reason, "incomplete");
    assert.deepEqual(error.usage, expected);
    return true;
  });
});

test("ideas instructions carry the persona, plain language, originality and short-film rules", () => {
  const composed = composeInstructions("ideas", "short_film");
  assert.ok(composed.startsWith([SOURCE_RULES, DIRECTOR_PERSONA, PLAIN_LANGUAGE].join("\n")));
  assert.equal(composed.split(DIRECTOR_PERSONA).length - 1, 1);
  assert.ok(!composed.includes(DISCOVERY_STYLE) && !composed.includes(ANALYSIS_STYLE));
  assert.ok(!/\bYou are an?\b/i.test(composed.replace(DIRECTOR_PERSONA, "")));
  assert.ok(composed.includes("not a title generator"));
  assert.ok(composed.includes("ORIGINAL ideas"));
  assert.ok(composed.includes("never adapt, retell"));
  assert.ok(composed.includes('"in the style of" a named filmmaker'));
  assert.ok(composed.includes("3–5 concepts"));
  assert.ok(composed.includes("different genre, setting, central conflict and emotional register"));
  assert.ok(composed.includes("Never repeat or lightly vary anything in avoid"));
  assert.ok(composed.includes(SURPRISE_ME));
  assert.ok(composed.includes("under 25 words"));
  assert.ok(composed.includes("small cast, few locations and one clear dramatic idea"));
  for (const format of FILM_FORMATS) {
    const text = composeInstructions("ideas", format);
    assert.ok(text.startsWith(SOURCE_RULES) && text.includes(DIRECTOR_PERSONA), format);
    assert.ok(text.split("\n").at(-1)?.startsWith("Make every concept"), format);
  }
});

test("interview and plan treat an AI-suggested starting concept as a suggestion", () => {
  assert.ok(SUGGESTED_CONCEPT_MARKER.startsWith("AI-suggested starting concept"));
  assert.ok(SUGGESTED_CONCEPT_RULE.includes('"AI-suggested starting concept"'));
  assert.ok(SUGGESTED_CONCEPT_RULE.includes("source ai"));
  const interview = composeInstructions("interview", "short_film");
  const plan = composeInstructions("plan_outline", "short_film");
  for (const composed of [interview, plan]) assert.ok(composed.includes(SUGGESTED_CONCEPT_RULE));
  assert.ok(interview.includes("Use discovery to let the filmmaker confirm or change its key parts"));
  assert.ok(plan.includes("so they can confirm or change them"));
  for (const step of ["draft", "refine"] as const) {
    assert.ok(!composeInstructions(step, "short_film").includes(SUGGESTED_CONCEPT_RULE), step);
  }
});

test("POST /api/story/ideas validates and bounds the request before needing a key", async () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST(
      new Request("http://localhost/api/story/ideas", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post({ mode: "brainstorm" })).status, 400);
    assert.equal((await post({ mode: "combine", concepts: [concept(0)], note: "" })).status, 400);
    assert.equal((await post(generate("x"), { "content-length": "70000" })).status, 413);
    const noKey = await post(generate(SURPRISE_ME));
    assert.equal(noKey.status, 503);
    assert.match((await noKey.json()).error, /OPENAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
