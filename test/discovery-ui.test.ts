import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { answerFor, DISCOVERY_ACTIONS } from "../src/lib/quick-actions.ts";
import {
  DECIDE_ANSWER,
  detectDiscoveryCommand,
  MAX_CONTEXT_FACTS,
  SKIPPED_ANSWER,
  type StoryContext,
  toCollected,
} from "../src/lib/story-context.ts";
import {
  askInterview,
  directorCollected,
  MAX_ANSWER_OPTION_CHARACTERS,
  parseAnswerOptions,
  parseStoryContext,
} from "../src/lib/studio-agent.ts";

const fact = (label: string, source: "user" | "ai" = "user") => ({
  category: "concept" as const,
  label,
  value: `${label} value`,
  source,
  approved: source === "user",
});

test("each discovery button label is detected as its own command", () => {
  for (const action of DISCOVERY_ACTIONS) assert.equal(detectDiscoveryCommand(action.label), action.command);
  assert.deepEqual(DISCOVERY_ACTIONS.map((action) => action.command).sort(), ["decide", "skip", "stop"]);
});

test("typed stop words end the interview; sentences that mention stop do not", () => {
  for (const text of ["stop", "Stop.", "proceed", "generate plan", "done"]) assert.equal(detectDiscoveryCommand(text), "stop");
  assert.equal(detectDiscoveryCommand("She tells him to stop the car"), null);
});

test("answerFor records markers for skip/decide and the user's words otherwise", () => {
  assert.equal(answerFor("skip", "skip"), SKIPPED_ANSWER);
  assert.equal(answerFor("decide", "you decide"), DECIDE_ANSWER);
  assert.equal(answerFor(null, "A lighthouse keeper"), "A lighthouse keeper");
});

test("parseStoryContext keeps valid facts, drops malformed ones and rejects non-contexts", () => {
  const parsed = parseStoryContext({
    facts: [fact("Premise"), { ...fact("Bad"), category: "nope" }, { label: "x" }, fact("Twist", "ai")],
    unresolved: ["Who narrates?", 3, "  "],
  });
  assert.deepEqual(parsed?.facts.map((item) => item.label), ["Premise", "Twist"]);
  assert.deepEqual(parsed?.unresolved, ["Who narrates?"]);
  assert.equal(parseStoryContext(undefined), null);
  assert.equal(parseStoryContext({ facts: "x", unresolved: [] }), null);
  const many = parseStoryContext({ facts: Array.from({ length: 100 }, (_, i) => fact(`F${i}`)), unresolved: [] });
  assert.equal(many?.facts.length, MAX_CONTEXT_FACTS);
});

test("directorCollected flattens the context when present and falls back to collected", () => {
  const context: StoryContext = { facts: [fact("Premise")], unresolved: [] };
  assert.deepEqual(directorCollected(context, [{ label: "old", detail: "x" }]), toCollected(context, 40));
  const legacy = Array.from({ length: 50 }, (_, i) => ({ label: `L${i}`, detail: "d" }));
  assert.equal(directorCollected(undefined, legacy).length, 40);
});

test("parseAnswerOptions accepts up to four short answers and rejects anything else", () => {
  assert.deepEqual(parseAnswerOptions([" A lighthouse keeper ", "A fisherman", "a fisherman"]), ["A lighthouse keeper", "A fisherman"]);
  assert.deepEqual(parseAnswerOptions([]), []);
  for (const bad of [
    undefined,
    null,
    "A, B",
    ["A", "B", "C", "D", "E"],
    ["A", ""],
    ["A", 3],
    ["x".repeat(MAX_ANSWER_OPTION_CHARACTERS + 1)],
  ]) {
    assert.deepEqual(parseAnswerOptions(bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(parseAnswerOptions(["x".repeat(MAX_ANSWER_OPTION_CHARACTERS)]), ["x".repeat(MAX_ANSWER_OPTION_CHARACTERS)]);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function reply(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

test("askInterview returns a question's answer options, and none for a finished interview", async () => {
  const turn = { note: "", rationale: "", collected: [], context: { facts: [], unresolved: [] } };
  reply({ ...turn, status: "ask", question: "Who is it about?", options: ["A keeper", "A child"] });
  const asked = await askInterview("The Lighthouse", []);
  assert.ok(asked.ok);
  assert.deepEqual(asked.options, ["A keeper", "A child"]);

  reply({ ...turn, status: "ask", question: "Who is it about?" });
  const without = await askInterview("The Lighthouse", []);
  assert.ok(without.ok);
  assert.deepEqual(without.options, []);

  reply({ ...turn, status: "complete", recommendation: "Plan it", options: ["Ignored"] });
  const done = await askInterview("The Lighthouse", []);
  assert.ok(done.ok);
  assert.deepEqual(done.options, []);
});
