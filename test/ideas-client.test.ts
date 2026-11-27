import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  conceptFacts,
  conceptSource,
  type IdeasRequest,
  MAX_AVOID,
  MAX_COMBINE,
  MAX_IDEA_QUESTIONS,
  type StoryConcept,
} from "../src/lib/ideas.ts";
import {
  canCombine,
  IDEA_INPUT_LIMITS,
  ideaDirection,
  placeConcepts,
  rememberShown,
  sessionFromConcept,
  toggleSelected,
} from "../src/lib/ideas-flow.ts";
import {
  IDEA_ANSWER_MAX,
  IDEA_CHANGE_MAX,
  IDEA_DIRECTION_MAX,
  IDEA_NOTE_MAX,
  IDEA_QUESTION_MAX,
  ideasRequest,
} from "../src/lib/server/ideas.ts";
import { createSession, type StorySession } from "../src/lib/session.ts";
import { hasStorySource, SUGGESTED_CONCEPT_MARKER, storyForStep } from "../src/lib/source-text.ts";
import { EMPTY_CONTEXT, toCollected } from "../src/lib/story-context.ts";
import { askIdeas, askInterview } from "../src/lib/studio-agent.ts";
import type { UsageRecord } from "../src/lib/usage.ts";

const usage = (totalTokens: number): UsageRecord => ({
  step: "ideas",
  model: "test-model",
  inputTokens: totalTokens - 1,
  outputTokens: 1,
  totalTokens,
});

const concept = (id: string, title = `Idea ${id}`): StoryConcept => ({
  id,
  title,
  genre: "Drama",
  premise: `Premise of ${title}`,
  mainCharacter: "A night-shift baker",
  conflict: "The bakery is being sold",
  emotionalHook: "Two sisters reconnect",
  plotDirection: "One last night of baking",
  cinematicAppeal: "Warm ovens against a dark city",
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown, status = 200): { calls: { url: string; body: unknown }[] } {
  const record: { calls: { url: string; body: unknown }[] } = { calls: [] };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    record.calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return record;
}

test("sessionFromConcept seeds a suggestion source and only unapproved AI facts, appending usage", () => {
  const other: StorySession = { ...createSession("Existing project"), usage: [usage(10)] };
  const fresh: StorySession = { ...createSession("Idea a"), usage: [usage(5)] };
  const chosen = concept("a");
  const explorerUsage = [usage(100), usage(200)];
  const sessions = [fresh, other].map((session) =>
    session.id === fresh.id ? sessionFromConcept(session, chosen, explorerUsage) : session,
  );
  const seeded = sessions[0];

  assert.deepEqual(seeded.source, conceptSource(chosen));
  assert.equal(seeded.source?.kind, "suggestion");
  const facts = seeded.context?.facts ?? [];
  assert.equal(facts.length, conceptFacts(chosen).length);
  assert.ok(facts.every((fact) => fact.source === "ai" && fact.approved === false));
  assert.deepEqual(seeded.collected, toCollected(seeded.context ?? EMPTY_CONTEXT));
  assert.deepEqual(seeded.usage, [usage(5), usage(100), usage(200)]);
  assert.equal(seeded.id, fresh.id);
  assert.equal(seeded.title, fresh.title);
  assert.equal(sessions[1], other);
  assert.deepEqual(other.usage, [usage(10)]);
  assert.equal(other.source, undefined);
});

test("a suggestion source is sent under the AI-suggestion marker, never as an imported story", () => {
  for (const step of ["interview", "plan"] as const) {
    const story = storyForStep("Idea a", conceptSource(concept("a")), step);
    assert.ok(story.ok);
    if (!story.ok) return;
    assert.ok(story.story.includes(SUGGESTED_CONCEPT_MARKER));
    assert.ok(story.story.includes("Premise: Premise of Idea a"));
    assert.equal(hasStorySource(story.story), false);
  }
});

test("askIdeas posts to /api/story/ideas and gives every concept a fresh unique id", async () => {
  const calls = mockFetch({ question: null, concepts: [concept("dup"), concept("dup", "Other")], usage: usage(42) });
  const request: IdeasRequest = { mode: "generate", direction: "A mystery", answers: [], avoid: [] };
  const result = await askIdeas(request);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(calls.calls[0].url, "/api/story/ideas");
  assert.deepEqual(calls.calls[0].body, request);
  assert.equal(result.response.concepts.length, 2);
  const ids = result.response.concepts.map((item) => item.id);
  assert.notEqual(ids[0], "dup");
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(result.response.usage, usage(42));
});

test("askIdeas returns a follow-up question only while generate may still ask one", async () => {
  const question = { text: "Funny or eerie?", options: ["Funny", "Eerie", 3] };
  mockFetch({ question, concepts: [], usage: usage(7) });
  const asked = await askIdeas({ mode: "generate", direction: "A mystery", answers: [], avoid: [] });
  assert.ok(asked.ok);
  if (asked.ok) assert.deepEqual(asked.response.question, { text: "Funny or eerie?", options: ["Funny", "Eerie"] });

  const answers = Array.from({ length: MAX_IDEA_QUESTIONS }, (_, index) => ({ question: `Q${index}`, answer: "A" }));
  mockFetch({ question, concepts: [], usage: usage(7) });
  const capped = await askIdeas({ mode: "generate", direction: "A mystery", answers, avoid: [] });
  assert.equal(capped.ok, false);
});

test("askIdeas rejects malformed responses and surfaces server errors", async () => {
  const malformed: unknown[] = [
    { question: null, concepts: "nope", usage: usage(1) },
    { question: null, concepts: [{ title: "Only a title" }], usage: usage(1) },
    { question: null, concepts: [concept("a")] },
    { question: { options: [] }, concepts: [concept("a")], usage: usage(1) },
    { question: "Pick one", concepts: [concept("a")], usage: usage(1) },
  ];
  for (const body of malformed) {
    mockFetch(body);
    const result = await askIdeas({ mode: "another", direction: "x", answers: [], avoid: [] });
    assert.equal(result.ok, false, JSON.stringify(body));
  }
  mockFetch({ error: "Too many ideas requested." }, 400);
  const failed = await askIdeas({ mode: "refine", concept: concept("a"), change: "funnier" });
  assert.deepEqual(failed, { ok: false, error: "Too many ideas requested." });
});

test("refine/another results replace the right card; explore-another and combine append", () => {
  const list = [concept("a"), concept("b"), concept("c")];
  const replaced = placeConcepts(list, [concept("new")], { kind: "replace", id: "b" });
  assert.deepEqual(replaced.map((item) => item.id), ["a", "new", "c"]);
  assert.deepEqual(list.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(
    placeConcepts(list, [concept("new")], { kind: "append" }).map((item) => item.id),
    ["a", "b", "c", "new"],
  );
  assert.deepEqual(
    placeConcepts(list, [concept("new")], { kind: "replace", id: "gone" }).map((item) => item.id),
    ["a", "b", "c", "new"],
  );
  assert.equal(placeConcepts(list, [], { kind: "append" }), list);
});

test("the avoid list keeps every shown concept once and the newest under the MAX_AVOID cap", () => {
  const shown = Array.from({ length: MAX_AVOID + 5 }, (_, index) => concept(String(index)));
  const avoid = rememberShown([], shown);
  assert.equal(avoid.length, MAX_AVOID);
  assert.equal(avoid.at(-1)?.title, `Idea ${MAX_AVOID + 4}`);
  assert.equal(avoid[0].title, "Idea 5");
  assert.equal(rememberShown(avoid, [shown.at(-1) as StoryConcept]).length, MAX_AVOID);
  assert.deepEqual(rememberShown([], [concept("x")]), [{ title: "Idea x", premise: "Premise of Idea x" }]);
});

test("combine selection is limited to 2–MAX_COMBINE concepts", () => {
  let selected: string[] = [];
  for (const id of ["a", "b", "c", "d"]) selected = toggleSelected(selected, id);
  assert.equal(selected.length, MAX_COMBINE);
  assert.ok(!selected.includes("d"));
  assert.deepEqual(toggleSelected(selected, "a"), selected.filter((id) => id !== "a"));
  assert.equal(canCombine(1), false);
  assert.equal(canCombine(2), true);
  assert.equal(canCombine(MAX_COMBINE), true);
  assert.equal(canCombine(MAX_COMBINE + 1), false);
});

test("the opening direction combines the chosen chip and typed text", () => {
  assert.equal(ideaDirection("A genre I love", " noir "), "A genre I love: noir");
  assert.equal(ideaDirection("A genre I love", "  "), "A genre I love");
  assert.equal(ideaDirection(null, " a heist "), "a heist");
  assert.equal(ideaDirection(null, ""), "");
});

test("the title flow is unchanged: title-only story and no context in the opening interview", async () => {
  const session = createSession("  The Lighthouse Keeper ");
  assert.equal(session.title, "The Lighthouse Keeper");
  assert.equal(session.source, undefined);
  assert.equal(session.context, undefined);
  const story = storyForStep(session.title, session.source, "interview");
  assert.deepEqual(story, { ok: true, story: "The Lighthouse Keeper", condensed: false });

  const calls = mockFetch({ status: "ask", question: "Who is it about?", note: "", rationale: "", collected: [] });
  await askInterview("The Lighthouse Keeper", [], session.context);
  assert.deepEqual(calls.calls[0].body, { step: "interview", story: "The Lighthouse Keeper", answered: [] });

  const seeded = sessionFromConcept(createSession("Idea a"), concept("a"), []);
  const seededCalls = mockFetch({ status: "ask", question: "Who is it about?", note: "", rationale: "", collected: [] });
  await askInterview("Idea a", [], seeded.context);
  assert.deepEqual((seededCalls.calls[0].body as { context: unknown }).context, seeded.context);
});

test("client input limits match the server schema and every explorer request passes it", async () => {
  assert.deepEqual(IDEA_INPUT_LIMITS, {
    direction: IDEA_DIRECTION_MAX,
    question: IDEA_QUESTION_MAX,
    answer: IDEA_ANSWER_MAX,
    change: IDEA_CHANGE_MAX,
    note: IDEA_NOTE_MAX,
  });
  const shown = Array.from({ length: MAX_AVOID + 3 }, (_, index) => concept(String(index)));
  const avoid = rememberShown([], shown);
  const answers = [{ question: "Funny or eerie?", answer: "Eerie" }];
  const requests: IdeasRequest[] = [
    { mode: "generate", direction: ideaDirection("A genre I love", "noir"), answers, avoid },
    { mode: "another", direction: "Surprise me", answers: [], avoid },
    { mode: "refine", concept: concept("a"), change: "Make it funnier" },
    { mode: "combine", concepts: [concept("a"), concept("b")], note: "" },
  ];
  for (const request of requests) {
    const calls = mockFetch({ question: null, concepts: [concept("x")], usage: usage(1) });
    await askIdeas(request);
    assert.ok(ideasRequest.safeParse(calls.calls[0].body).success, request.mode);
  }
});
