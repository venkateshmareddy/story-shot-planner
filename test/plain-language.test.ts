import assert from "node:assert/strict";
import { test } from "node:test";
import { specialistInstructions } from "@/lib/agents/shared";
import { ANALYSIS_STYLE, composeInstructions, DISCOVERY_STYLE, PLAIN_LANGUAGE } from "@/lib/server/prompts";

test("every story stage asks the model for plain, everyday English", () => {
  for (const step of ["draft", "interview", "plan_outline", "plan_scene", "edit_plan", "edit_scene"] as const) {
    assert.ok(composeInstructions(step, "short_film").includes(PLAIN_LANGUAGE), step);
  }
});

test("specialist instructions include the plain-language rule", () => {
  assert.ok(specialistInstructions("Sound Director", "Sound.", "Edit only sound.").includes(PLAIN_LANGUAGE));
});

test("plain language sets no length limit, so analysis is never truncated by it", () => {
  assert.ok(!PLAIN_LANGUAGE.toLowerCase().includes("one short sentence"));
  assert.ok(!/\b(?:under|at most|no more than|maximum of)\s+\d+\s+(?:words|sentences|characters)\b/i.test(PLAIN_LANGUAGE));
  assert.ok(!/\b\d+\s+words\b/i.test(PLAIN_LANGUAGE));
});

test("plain language targets a 12-year-old reader and rules out poetic lines with a real example", () => {
  assert.ok(PLAIN_LANGUAGE.includes("12-year-old"));
  assert.ok(PLAIN_LANGUAGE.includes("short sentences"));
  assert.ok(PLAIN_LANGUAGE.includes("No poetic, literary or metaphorical lines"));
  assert.ok(PLAIN_LANGUAGE.includes("The keeper can watch for ships all night and still have no idea where she came from."));
  assert.ok(PLAIN_LANGUAGE.includes("characters' dialogue can sound however the story needs"));
  assert.ok(PLAIN_LANGUAGE.includes("in brackets, for example close-up (the camera very near the face)"));
});

test("discovery asks one short question with tappable options and a plain why", () => {
  assert.ok(DISCOVERY_STYLE.includes('starting "Got it:"'));
  assert.ok(DISCOVERY_STYLE.includes("empty when nothing has been said yet"));
  assert.ok(DISCOVERY_STYLE.includes("under 15 words"));
  assert.ok(DISCOVERY_STYLE.includes("never put the answer choices inside the question"));
  assert.ok(DISCOVERY_STYLE.includes("options: 2–4 short answer choices"));
  assert.ok(DISCOVERY_STYLE.includes("[] for an open question such as a name"));
  assert.ok(DISCOVERY_STYLE.includes('starting "Why I ask:"'));
  assert.ok(DISCOVERY_STYLE.includes("never present your own idea"));
  assert.ok(DISCOVERY_STYLE.includes('say "I suggest…"'));
});

test("analysis opens with a one-line plain answer, then grouped points with terms explained", () => {
  assert.ok(ANALYSIS_STYLE.includes("the first line is a one-line plain answer"));
  assert.ok(ANALYSIS_STYLE.includes('lines starting with "- ", one idea per point'));
  assert.ok(ANALYSIS_STYLE.includes("label lines ending in a colon"));
  for (const step of ["draft", "plan_outline", "edit_plan"] as const) {
    const composed = composeInstructions(step, "short_film");
    assert.ok(composed.includes(ANALYSIS_STYLE) && composed.includes(PLAIN_LANGUAGE), step);
  }
  assert.ok(ANALYSIS_STYLE.includes("S01_SH02"));
});
