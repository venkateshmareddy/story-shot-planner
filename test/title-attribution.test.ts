import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeFacts, type InterviewTurnOutput, resolveInterviewTurn } from "@/lib/interview";
import { composeInstructions } from "@/lib/server/prompts";
import { hasStorySource, storyForStep } from "@/lib/source-text";
import {
  DECIDE_ANSWER,
  EMPTY_CONTEXT,
  factKey,
  retractAnswerFacts,
  SKIPPED_ANSWER,
  type StoryContext,
} from "@/lib/story-context";

const boy = { category: "characters", label: "Main character", value: "A boy", source: "user" } as const;

function turn(facts: InterviewTurnOutput["facts"]): InterviewTurnOutput {
  return {
    note: "",
    complete: false,
    question: "What does the boy want?",
    options: [],
    rationale: "",
    recommendation: "",
    facts,
    visuals: [],
    asks: "",
    unresolved: [],
  };
}

test("a title alone never becomes the filmmaker's decision", () => {
  const resolved = resolveInterviewTurn(turn([boy]), [], EMPTY_CONTEXT, 12, { titleOnly: true });
  const fact = resolved.context.facts[0];
  assert.equal(fact.source, "ai");
  assert.equal(fact.approved, false);
});

test("facts from an imported story stay the filmmaker's", () => {
  const story = storyForStep("A boy", { name: "story.txt", kind: "txt", characters: 30, text: "A boy finds a lost dog." }, "interview");
  assert.ok(story.ok && hasStorySource(story.story));
  assert.equal(hasStorySource("A boy"), false);
  const [fact] = attributeFacts([boy], [], EMPTY_CONTEXT, false);
  assert.equal(fact.source, "user");
  assert.equal(fact.approved, true);
});

test("the model can't promote its own unchanged suggestion to the filmmaker's", () => {
  const context: StoryContext = { facts: [{ ...boy, source: "ai", approved: false }], unresolved: [] };
  const answered = [{ question: "What does the boy want?", answer: "To find his dog." }];
  const [fact] = attributeFacts([boy], answered, context, true);
  assert.equal(fact.source, "ai");
  assert.equal(fact.approved, false);
});

test("a new detail from the filmmaker's answer is theirs", () => {
  const answered = [{ question: "Who is it about?", answer: "Ravi, a ten-year-old who loves trains." }];
  const [fact] = attributeFacts(
    [{ category: "characters", label: "Main character", value: "Ravi, ten, loves trains", source: "user" }],
    answered,
    { facts: [{ ...boy, source: "ai", approved: false }], unresolved: [] },
    true,
  );
  assert.equal(fact.source, "user");
  assert.equal(fact.approved, true);
});

test("the interview prompt says a title is not a creative decision", () => {
  const text = composeInstructions("interview", "short_film");
  assert.ok(text.includes("a title is not a creative decision"));
  assert.ok(text.includes("must have source ai"));
});

const said = (...answers: string[]) => answers.map((answer, index) => ({ question: `Q${index}?`, answer }));

test("a filmmaker fact records the answer it came from", () => {
  const [fact] = attributeFacts([boy], said("It's about a boy.", "He is called Ravi."), EMPTY_CONTEXT, true);
  assert.equal(fact.source, "user");
  assert.equal(fact.answer, 1);
  const [imported] = attributeFacts([boy], [], EMPTY_CONTEXT, false);
  assert.equal(imported.source, "user");
  assert.ok(!("answer" in imported));
  const [guess] = attributeFacts([{ ...boy, source: "ai" }], said("Yes."), EMPTY_CONTEXT, true);
  assert.ok(!("answer" in guess));
});

test("restating an existing filmmaker fact keeps it theirs with its original answer", () => {
  const context: StoryContext = {
    facts: [{ ...boy, value: "A boy", source: "user", approved: true, answer: 0 }],
    unresolved: [],
  };
  const [fact] = attributeFacts([{ ...boy, value: "  a BOY " }], said("A boy.", "He likes trains."), context, true);
  assert.deepEqual(fact, context.facts[0]);
  const edited: StoryContext = { facts: [{ ...boy, source: "user", approved: true }], unresolved: [] };
  const [kept] = attributeFacts([boy], said("A boy.", DECIDE_ANSWER), edited, true);
  assert.equal(kept.source, "user");
  assert.ok(!("answer" in kept));
});

test("a changed filmmaker fact is tied to the latest answer", () => {
  const context: StoryContext = { facts: [{ ...boy, source: "user", approved: true, answer: 0 }], unresolved: [] };
  const [fact] = attributeFacts([{ ...boy, value: "A girl" }], said("A boy.", "Actually a girl."), context, true);
  assert.equal(fact.source, "user");
  assert.equal(fact.answer, 1);
});

test("after You decide or Skip, new details are AI suggestions", () => {
  for (const answer of [DECIDE_ANSWER, SKIPPED_ANSWER]) {
    const resolved = resolveInterviewTurn(
      turn([boy, { category: "genre", label: "Genre", value: "Comedy", source: "user" }]),
      said("It's set in Mumbai.", answer),
      EMPTY_CONTEXT,
      12,
      { titleOnly: true },
    );
    for (const fact of resolved.context.facts) {
      assert.equal(fact.source, "ai", `${answer} ${fact.label}`);
      assert.equal(fact.approved, false, `${answer} ${fact.label}`);
      assert.ok(!("answer" in fact));
    }
  }
});

test("editing an answer retracts only the facts taken from it", () => {
  const first = resolveInterviewTurn(turn([boy]), said("A boy."), EMPTY_CONTEXT, 12, { titleOnly: true });
  const genre = { category: "genre", label: "Genre", value: "Comedy", source: "user" } as const;
  const second = resolveInterviewTurn(turn([genre]), said("A boy.", "A comedy."), first.context, 12, { titleOnly: true });
  const retracted = retractAnswerFacts(second.context, 0);
  assert.deepEqual(
    retracted.facts.map((fact) => factKey(fact)),
    ["genre:genre"],
  );
});

test("the interview prompt asks for plain fact wording and respects removed details", () => {
  const text = composeInstructions("interview", "short_film");
  assert.ok(text.includes("never hedge (possible, maybe)"));
  assert.ok(text.includes("never say where it came from"));
  assert.ok(text.includes("REMOVED lists details the filmmaker deleted: never add them back"));
});
