import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeFacts, type InterviewTurnOutput, resolveInterviewTurn } from "@/lib/interview";
import { composeInstructions } from "@/lib/server/prompts";
import { hasStorySource, storyForStep } from "@/lib/source-text";
import { EMPTY_CONTEXT, type StoryContext } from "@/lib/story-context";

const boy = { category: "characters", label: "Main character", value: "A boy", source: "user" } as const;

function turn(facts: InterviewTurnOutput["facts"]): InterviewTurnOutput {
  return { note: "", complete: false, question: "What does the boy want?", rationale: "", recommendation: "", facts, unresolved: [] };
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
