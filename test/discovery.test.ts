import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type InterviewExchange,
  type InterviewTurnOutput,
  isStopRequest,
  interviewTurnOutput,
  resolveInterviewTurn,
  STOP_RECOMMENDATION,
  stopTurn,
} from "../src/lib/interview.ts";
import { composeInstructions, DISCOVERY_STYLE, PLAIN_LANGUAGE } from "../src/lib/server/prompts.ts";
import {
  type ContextFact,
  contextReadiness,
  DECIDE_ANSWER,
  EMPTY_CONTEXT,
  MAX_UNRESOLVED,
  mergeFacts,
  missingCategories,
  SKIPPED_ANSWER,
  type StoryContext,
  toCollected,
} from "../src/lib/story-context.ts";
import { contextFactSchema, storyContextSchema } from "../src/lib/story-context-schema.ts";

function turn(overrides: Partial<InterviewTurnOutput> = {}): InterviewTurnOutput {
  return {
    note: "Clear premise.",
    complete: false,
    question: "Who is the main character?",
    options: [],
    rationale: "The audience needs someone to follow.",
    recommendation: "",
    facts: [],
    unresolved: [],
    ...overrides,
  };
}

const fact = (overrides: Partial<ContextFact> = {}): ContextFact => ({
  category: "concept",
  label: "Premise",
  value: "A night bus driver finds a lost child.",
  source: "user",
  approved: true,
  ...overrides,
});

const said = (...answers: string[]): InterviewExchange[] => answers.map((answer, i) => ({ question: `Q${i}?`, answer }));

test("fact extraction merges with correct source and approval", () => {
  const resolved = resolveInterviewTurn(
    turn({
      facts: [
        { category: "concept", label: "Premise", value: "A night bus driver finds a lost child.", source: "user" },
        { category: "lighting", label: "Look", value: "Sodium-orange streetlights", source: "ai" },
      ],
    }),
    [],
    EMPTY_CONTEXT,
  );
  assert.equal(resolved.status, "ask");
  const byLabel = Object.fromEntries(resolved.context.facts.map((f) => [f.label, f]));
  assert.equal(byLabel.Premise.source, "user");
  assert.equal(byLabel.Premise.approved, true);
  assert.equal(byLabel.Look.source, "ai");
  assert.equal(byLabel.Look.approved, false);
  assert.equal(storyContextSchema.safeParse(resolved.context).success, true);
  assert.equal(resolved.collected.length, 2);
});

test("an AI fact never overwrites a user or approved fact", () => {
  const start: StoryContext = {
    facts: [fact(), fact({ category: "genre", label: "Tone", value: "Warm", source: "ai", approved: true })],
    unresolved: [],
  };
  const resolved = resolveInterviewTurn(
    turn({
      facts: [
        { category: "concept", label: "premise", value: "Something else", source: "ai" },
        { category: "genre", label: "Tone", value: "Bleak", source: "ai" },
      ],
    }),
    [],
    start,
  );
  assert.deepEqual(resolved.context.facts, start.facts);
});

test("a user fact replaces an earlier AI suggestion", () => {
  const start: StoryContext = { facts: [fact({ source: "ai", approved: false, value: "Old guess" })], unresolved: [] };
  const merged = mergeFacts(start, [fact({ value: "New answer", approved: false })]);
  assert.deepEqual(merged.facts, [fact({ value: "New answer" })]);
});

test("unresolved is replaced, trimmed, deduped and capped", () => {
  const many = Array.from({ length: MAX_UNRESOLVED + 4 }, (_, i) => `Gap ${i}`);
  const resolved = resolveInterviewTurn(turn({ unresolved: [" Gap 0 ", "Gap 0", "", ...many] }), [], {
    facts: [],
    unresolved: ["Stale gap"],
  });
  assert.equal(resolved.context.unresolved.length, MAX_UNRESOLVED);
  assert.equal(resolved.context.unresolved[0], "Gap 0");
  assert.equal(new Set(resolved.context.unresolved).size, MAX_UNRESOLVED);
  assert.ok(!resolved.context.unresolved.includes("Stale gap"));
});

test("over-long model text is clipped so the context stays schema-valid", () => {
  const resolved = resolveInterviewTurn(
    turn({
      facts: [{ category: "scenes", label: "L".repeat(200), value: "V".repeat(2_000), source: "ai" }],
      unresolved: ["U".repeat(1_000)],
    }),
    [],
    EMPTY_CONTEXT,
  );
  assert.equal(storyContextSchema.safeParse(resolved.context).success, true);
});

test("model-facing interview text is clipped before the next request", () => {
  const resolved = resolveInterviewTurn(
    turn({ note: "N".repeat(2_000), question: "Q".repeat(700), rationale: "R".repeat(700) }),
    [],
    EMPTY_CONTEXT,
  );
  assert.equal(resolved.note.length, 200);
  assert.equal(resolved.status === "ask" && resolved.question.length, 500);
  assert.equal(resolved.status === "ask" && resolved.rationale.length, 200);
});

test("long note and rationale are clipped at a word boundary with an ellipsis", () => {
  const resolved = resolveInterviewTurn(
    turn({ note: "word ".repeat(80), rationale: "because ".repeat(60) }),
    [],
    EMPTY_CONTEXT,
  );
  assert.equal(resolved.status, "ask");
  assert.ok(resolved.note.length <= 200 && resolved.note.endsWith("word…"));
  assert.ok(resolved.status === "ask" && resolved.rationale.length <= 200 && resolved.rationale.endsWith("because…"));
});

test("stop request detection", () => {
  for (const answer of [
    "stop",
    "Please stop asking questions",
    "Please stop asking and generate the plan",
    "Proceed.",
    "Proceed with the plan",
    "generate plan",
    "Create the shot plan",
    "done",
  ]) {
    assert.equal(isStopRequest(said("A thriller.", answer)), true, answer);
  }
  for (const answer of ["the bus doesn't stop at night", "Stop the car, she says.", "A thriller."]) {
    assert.equal(isStopRequest(said(answer)), false, answer);
  }
  assert.equal(isStopRequest([]), false);
  assert.equal(isStopRequest(said("stop", "A thriller.")), false);
});

test("skip and decide recorded answers do not trigger stop", () => {
  assert.equal(isStopRequest(said(SKIPPED_ANSWER)), false);
  assert.equal(isStopRequest(said(DECIDE_ANSWER)), false);
});

test("stop turn completes with the context unchanged", () => {
  const context: StoryContext = { facts: [fact()], unresolved: ["Ending unclear"] };
  const resolved = stopTurn(context);
  assert.equal(resolved.status, "complete");
  assert.equal(resolved.status === "complete" && resolved.recommendation, STOP_RECOMMENDATION);
  assert.equal(resolved.context, context);
  assert.deepEqual(resolved.collected, toCollected(context));
  assert.ok(!("usage" in resolved));
});

test("readiness is true only when concept, genre and format are covered", () => {
  const concept = fact();
  const genre = fact({ category: "genre", label: "Genre", value: "Drama" });
  const format = fact({ category: "format", label: "Length", value: "5 minutes", source: "ai", approved: false });
  assert.equal(contextReadiness(EMPTY_CONTEXT).ready, false);
  assert.equal(contextReadiness({ facts: [concept, genre], unresolved: [] }).ready, false);
  assert.equal(
    contextReadiness({ facts: [concept, genre, fact({ category: "audience", label: "Audience", value: "Teens" })], unresolved: [] })
      .ready,
    false,
  );
  const ready = contextReadiness({ facts: [concept, genre, format], unresolved: [] });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.critical, { covered: 3, total: 3 });
});

test("missingCategories is ordered by priority", () => {
  const missing = missingCategories({ facts: [fact()], unresolved: [] }).map((category) => category.id);
  assert.deepEqual(missing.slice(0, 6), ["genre", "format", "audience", "characters", "structure", "intent"]);
  assert.ok(!missing.includes("concept"));
  assert.equal(missing.at(-1), "delivery");
});

test("toCollected puts user/approved facts first and marks AI suggestions", () => {
  const collected = toCollected({
    facts: [
      fact({ category: "lighting", label: "Look", value: "Neon", source: "ai", approved: false }),
      fact({ category: "sound", label: "Music", value: "Piano", source: "user" }),
      fact({ category: "genre", label: "Tone", value: "Hopeful", source: "ai", approved: true }),
    ],
    unresolved: [],
  });
  assert.deepEqual(collected, [
    { label: "Genre and tone: Tone", detail: "Hopeful" },
    { label: "Sound and music: Music", detail: "Piano" },
    { label: "Light and colour: Look", detail: "Neon (AI suggestion)" },
  ]);
});

test("schemas reject an unknown category", () => {
  assert.equal(contextFactSchema.safeParse(fact({ category: "budget" as ContextFact["category"] })).success, false);
  const output = turn({ facts: [{ category: "budget" as ContextFact["category"], label: "x", value: "y", source: "ai" }] });
  assert.equal(interviewTurnOutput.safeParse(output).success, false);
});

test("interview prompt carries the framework priorities and plain language", () => {
  const prompt = composeInstructions("interview", "short_film");
  assert.ok(prompt.includes(PLAIN_LANGUAGE));
  assert.ok(prompt.includes("critical concept, genre, format"));
  assert.ok(prompt.includes("optional lighting, sound, shots, production, references, delivery"));
  assert.ok(prompt.includes(SKIPPED_ANSWER));
  assert.ok(prompt.includes(DECIDE_ANSWER));
  assert.ok(prompt.toLowerCase().includes("exactly one"));
});

test("interview prompt builds on the latest answer without demanding a rationale every turn", () => {
  const prompt = composeInstructions("interview", "short_film");
  assert.ok(prompt.includes("Build the next question on the filmmaker's latest answer"));
  assert.ok(prompt.includes("never re-ask an earlier question in different words"));
  assert.ok(prompt.includes("ask only the most important one now"));
  assert.ok(prompt.includes(DISCOVERY_STYLE));
  assert.ok(DISCOVERY_STYLE.includes("options: 2–4 short answer choices that fit this story"));
  assert.ok(DISCOVERY_STYLE.includes("never put the answer choices inside the question"));
  assert.ok(!prompt.includes("offer 2–3 concrete options"));
  assert.ok(prompt.includes("Never ask for anything already known, answered or reasonably inferable"));
  assert.ok(!prompt.includes("a rationale saying why it helps the film"));
  assert.ok(!prompt.includes("Put your short read of the latest answer in note"));
});

test("plan prompts bind user/approved facts, list assumptions and allow original dialogue", () => {
  const outline = composeInstructions("plan_outline", "short_film");
  assert.ok(outline.includes(PLAIN_LANGUAGE));
  assert.ok(outline.includes("every From the filmmaker or Approved fact as binding"));
  assert.ok(outline.includes("assumptions in reviewNotes"));
  assert.ok(outline.includes("REMOVED lists details the filmmaker deleted: never use them"));
  const scene = composeInstructions("plan_scene", "short_film");
  assert.ok(scene.includes(PLAIN_LANGUAGE));
  assert.ok(scene.includes("original dialogue"));
  assert.ok(scene.includes("binding"));
});
