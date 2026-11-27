import assert from "node:assert/strict";
import { test } from "node:test";
import { findPlanProblem } from "../src/lib/server/plan-validation.ts";
import { planningRequest, type ShotPlan } from "../src/lib/story-planning.ts";

type Shot = ShotPlan["scenes"][number]["shots"][number];

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    seconds: 4,
    framing: "Medium close-up",
    camera: "Slow push-in",
    characters: ["Mara"],
    location: "Lighthouse",
    action: "Mara turns from the window.",
    dialogue: [{ speaker: "Mara", line: "The light never failed until tonight.", delivery: "Quiet, shaken" }],
    emotion: "Dread",
    sound: "Wind against glass",
    ...overrides,
  };
}

function plan(scenes: ShotPlan["scenes"] = [{ title: "Arrival", shots: [shot()] }]): ShotPlan {
  return {
    title: "The Last Keeper",
    logline: "A keeper fights to relight a dying lighthouse.",
    intent: "Isolation giving way to resolve.",
    characters: [{ name: "Mara", role: "Keeper", look: "Oilskin coat", personality: "Stubborn", voice: "Low" }],
    locations: [{ name: "Lighthouse", description: "Storm-battered tower" }],
    scenes,
    reviewNotes: [],
  };
}

const answers = [
  { question: "Who is the protagonist?", answer: "Mara, the last lighthouse keeper (edited: now in her sixties)." },
  { question: "How does it end?", answer: "She relights the lamp as a ship passes." },
];

test("planningRequest accepts a plan request with collected details and edited answers", () => {
  const parsed = planningRequest.safeParse({
    step: "plan",
    story: "The Last Keeper",
    answers,
    collected: [{ label: "Tone", detail: "Bleak, then hopeful" }],
    format: "short_film",
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.step, "plan");
  if (parsed.data.step === "plan") {
    assert.equal(parsed.data.collected?.length, 1);
    assert.equal(parsed.data.answers[0].answer, answers[0].answer);
  }
});

test("planningRequest rejects more than 40 collected details", () => {
  const collected = Array.from({ length: 41 }, (_, i) => ({ label: `L${i}`, detail: `D${i}` }));
  assert.equal(planningRequest.safeParse({ step: "plan", story: "The Last Keeper", answers, collected }).success, false);
});

test("findPlanProblem accepts original dialogue absent from the title", () => {
  const valid = plan();
  assert.ok(!"The Last Keeper".includes(valid.scenes[0].shots[0].dialogue[0].line));
  assert.equal(findPlanProblem(valid), null);
  assert.equal(findPlanProblem(plan([{ title: "Silent", shots: [shot({ dialogue: [] })] }])), null);
});

test("findPlanProblem rejects structurally invalid plans", () => {
  assert.ok(findPlanProblem(plan([])));
  assert.ok(findPlanProblem(plan([{ title: "Empty", shots: [] }])));
  for (const seconds of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(findPlanProblem(plan([{ title: "Bad", shots: [shot({ seconds })] }])), `seconds=${seconds}`);
  }
  assert.ok(findPlanProblem(plan([{ title: "Bad", shots: [shot({ dialogue: [{ speaker: "Mara", line: "  ", delivery: "" }] })] }])));
  assert.ok(findPlanProblem(plan([{ title: "Bad", shots: [shot({ dialogue: [{ speaker: " ", line: "Hello.", delivery: "" }] })] }])));
});
