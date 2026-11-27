import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, type StorySession } from "../src/lib/session.ts";
import {
  approveFact,
  type ContextFact,
  editFact,
  factKey,
  MAX_FACT_VALUE,
  mergeFacts,
  removeFact,
  type StoryContext,
  toCollected,
} from "../src/lib/story-context.ts";
import { storyContextSchema } from "../src/lib/story-context-schema.ts";
import {
  adoptReturnedContext,
  parseStoryContext,
  withEditedAnswer,
  withSessionContext,
} from "../src/lib/studio-agent.ts";

const fact = (label: string, value: string, extra: Partial<ContextFact> = {}): ContextFact => ({
  category: "characters",
  label,
  value,
  source: "user",
  approved: true,
  ...extra,
});

const hero = fact("Main character", "Mara, a lighthouse keeper", { answer: 0 });
const place = fact("Setting", "A storm-battered island", { category: "locations", answer: 1 });
const tone = fact("Tone", "Quiet and eerie", { category: "genre", source: "ai", approved: false });
const ending = fact("Ending", "She leaves the island", { category: "structure", source: "ai", approved: true });

function session(): StorySession {
  const context: StoryContext = { facts: [hero, place, tone, ending], unresolved: [] };
  return {
    ...createSession("The Lighthouse"),
    answered: [
      { question: "Who is it about?", answer: "Mara, a lighthouse keeper" },
      { question: "Where does it happen?", answer: "A storm-battered island" },
    ],
    messages: [
      { id: "q1", role: "agent", text: "Who is it about?" },
      { id: "a1", role: "user", text: "Mara, a lighthouse keeper", answerIndex: 0 },
      { id: "q2", role: "agent", text: "Where does it happen?" },
      { id: "a2", role: "user", text: "A storm-battered island", answerIndex: 1 },
    ],
    context,
    collected: toCollected(context),
  };
}

test("editing any fact makes it the filmmaker's approved decision and keeps collected in step", () => {
  for (const target of [hero, tone, ending]) {
    const next = withSessionContext(session(), (context) => editFact(context, factKey(target), "  New wording  "));
    const edited = next.context?.facts.find((item) => factKey(item) === factKey(target));
    assert.equal(edited?.value, "New wording");
    assert.equal(edited?.source, "user");
    assert.equal(edited?.approved, true);
    assert.equal(edited?.answer, undefined);
    assert.deepEqual(next.collected, toCollected(next.context as StoryContext));
  }
});

test("an empty edit is ignored and the session object is unchanged", () => {
  const before = session();
  const after = withSessionContext(before, (context) => editFact(context, factKey(hero), "   "));
  assert.equal(after, before);
});

test("an edited value is capped at the fact limit and still passes the saved-session schema", () => {
  const next = withSessionContext(session(), (context) => editFact(context, factKey(tone), "x".repeat(MAX_FACT_VALUE + 50)));
  assert.equal(next.context?.facts.find((item) => item.label === "Tone")?.value.length, MAX_FACT_VALUE);
  assert.ok(storyContextSchema.safeParse(next.context).success);
});

test("removing any fact drops it, remembers it, and the AI can't add the same detail back", () => {
  for (const target of [hero, tone, ending]) {
    const next = withSessionContext(session(), (context) => removeFact(context, factKey(target)));
    assert.ok(!next.context?.facts.some((item) => factKey(item) === factKey(target)));
    assert.deepEqual(next.context?.removed, [{ key: factKey(target), value: target.value }]);
    assert.deepEqual(next.collected, toCollected(next.context as StoryContext));
    const readded = mergeFacts(next.context as StoryContext, [{ ...target, source: "ai", approved: false }]);
    assert.ok(!readded.facts.some((item) => factKey(item) === factKey(target)));
    assert.ok(storyContextSchema.safeParse(next.context).success);
  }
});

test("approving a suggestion keeps collected in step", () => {
  const next = withSessionContext(session(), (context) => approveFact(context, factKey(tone)));
  assert.equal(next.context?.facts.find((item) => item.label === "Tone")?.approved, true);
  assert.ok(!next.collected.some((item) => item.detail.includes("(AI suggestion)")));
});

test("a session without a context is left alone", () => {
  const legacy = { ...session(), context: undefined };
  assert.equal(withSessionContext(legacy, (context) => removeFact(context, factKey(hero))), legacy);
});

test("editing an answer rewrites it, retracts only the filmmaker facts taken from it, and makes no other change", () => {
  const before = session();
  const after = withEditedAnswer(before, "a1", "  Theo, a retired ferryman ");
  assert.ok(after);
  assert.equal(after.answered[0].answer, "Theo, a retired ferryman");
  assert.equal(after.answered[1], before.answered[1]);
  assert.equal(after.messages.find((message) => message.id === "a1")?.text, "Theo, a retired ferryman");
  assert.deepEqual(after.context?.facts.map((item) => item.label), ["Setting", "Tone", "Ending"]);
  assert.deepEqual(after.collected, toCollected(after.context as StoryContext));
  assert.equal(after.usage, before.usage);
});

test("editing an answer to a command records the marker; invalid edits return null", () => {
  const skipped = withEditedAnswer(session(), "a2", "skip");
  assert.match(skipped?.answered[1].answer ?? "", /^\(Skipped/);
  assert.deepEqual(skipped?.context?.facts.map((item) => item.label), ["Main character", "Tone", "Ending"]);
  assert.equal(withEditedAnswer(session(), "a1", "   "), null);
  assert.equal(withEditedAnswer(session(), "q1", "Not an answer"), null);
  assert.equal(withEditedAnswer(session(), "missing", "Anything"), null);
});

test("an interview reply's context keeps the filmmaker's removals", () => {
  const removed = [{ key: factKey(tone), value: tone.value }];
  const previous: StoryContext = { facts: [hero], unresolved: [], removed };
  assert.deepEqual(adoptReturnedContext(previous, { facts: [hero, place], unresolved: [] }).removed, removed);
  const returned: StoryContext = { facts: [hero], unresolved: [], removed: [{ key: "x:y", value: "z" }] };
  assert.equal(adoptReturnedContext(previous, returned), returned);
  assert.deepEqual(adoptReturnedContext(undefined, { facts: [], unresolved: [] }), { facts: [], unresolved: [] });
});

test("parseStoryContext keeps answer links and well-formed removals", () => {
  const parsed = parseStoryContext({
    facts: [hero, tone],
    unresolved: [],
    removed: [{ key: factKey(tone), value: tone.value }, { key: "", value: "bad" }, "nope"],
  });
  assert.equal(parsed?.facts[0].answer, 0);
  assert.deepEqual(parsed?.removed, [{ key: factKey(tone), value: tone.value }]);
  assert.equal(parseStoryContext({ facts: [], unresolved: [] })?.removed, undefined);
});
