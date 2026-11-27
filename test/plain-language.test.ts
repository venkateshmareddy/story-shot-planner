import assert from "node:assert/strict";
import { test } from "node:test";
import { specialistInstructions } from "@/lib/agents/shared";
import { composeInstructions, PLAIN_LANGUAGE } from "@/lib/server/prompts";

test("every story stage asks the model for plain, everyday English", () => {
  for (const step of ["draft", "interview", "plan", "refine"] as const) {
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
