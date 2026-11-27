import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addExtraDirection,
  EXTRA_DIRECTION_QUESTION,
  MAX_EXTRA_DIRECTIONS,
  MAX_INTERVIEW_TURNS,
  MAX_PLAN_ANSWERS,
} from "../src/lib/interview.ts";
import { MAX_ANSWER_CHARACTERS } from "../src/lib/story-input.ts";
import { planningRequest } from "../src/lib/story-planning.ts";

const interview = (count: number) => Array.from({ length: count }, (_, index) => ({ question: `Question ${index + 1}?`, answer: `Answer ${index + 1}` }));
const planAccepts = (answers: { question: string; answer: string }[]) =>
  planningRequest.safeParse({ step: "plan", story: "sample story idea.", answers, collected: [] }).success;

test("a direction after a full interview is accepted by the plan request", () => {
  const full = interview(MAX_INTERVIEW_TURNS);
  const next = addExtraDirection(full, "the keeper name was aswin");
  assert.equal(next.length, MAX_INTERVIEW_TURNS + 1);
  assert.deepEqual(next.at(-1), { question: EXTRA_DIRECTION_QUESTION, answer: "the keeper name was aswin" });
  assert.ok(planAccepts(next));
  assert.deepEqual(full, interview(MAX_INTERVIEW_TURNS));
});

test("directions past the limit merge into the last one, so the plan request never grows past its cap", () => {
  let answered = interview(MAX_INTERVIEW_TURNS);
  for (let index = 0; index < MAX_EXTRA_DIRECTIONS + 5; index += 1) answered = addExtraDirection(answered, `direction ${index}`);
  assert.equal(answered.length, MAX_PLAN_ANSWERS);
  assert.ok(planAccepts(answered));
  assert.match(answered.at(-1)?.answer ?? "", /direction 12$/);
  assert.ok(planAccepts(addExtraDirection(answered, "x".repeat(MAX_ANSWER_CHARACTERS))));
});

test("a merged direction keeps the newest text within the answer limit", () => {
  let answered = interview(MAX_INTERVIEW_TURNS);
  for (let index = 0; index < MAX_EXTRA_DIRECTIONS; index += 1) answered = addExtraDirection(answered, "word ".repeat(300));
  const merged = addExtraDirection(answered, "newest direction");
  const last = merged.at(-1)?.answer ?? "";
  assert.ok(last.length <= MAX_ANSWER_CHARACTERS);
  assert.ok(last.endsWith("newest direction"));
});

test("blank directions change nothing", () => {
  const answered = interview(3);
  assert.equal(addExtraDirection(answered, "   "), answered);
});

test("the plan request still rejects more answers than interview plus directions", () => {
  assert.ok(planAccepts(interview(MAX_PLAN_ANSWERS)));
  assert.ok(!planAccepts(interview(MAX_PLAN_ANSWERS + 1)));
});
