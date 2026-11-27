import assert from "node:assert/strict";
import { test } from "node:test";
import { FILM_FORMATS } from "../src/lib/formats.ts";
import { composeInstructions, SOURCE_RULES } from "../src/lib/server/prompts.ts";

const STEPS = ["draft", "interview", "plan", "refine"] as const;

test("composeInstructions is deterministic and starts with SOURCE_RULES", () => {
  const first = composeInstructions("plan", "short_film");
  const second = composeInstructions("plan", "short_film");
  assert.equal(first, second);
  assert.ok(first.startsWith(SOURCE_RULES));
});

test("plan/short_film carries the behavior-critical directives", () => {
  const composed = composeInstructions("plan", "short_film");
  assert.ok(composed.includes("without surrounding quotation marks"));
  assert.ok(composed.includes("Never invent speaking characters, story events or lines"));
  assert.ok(composed.includes("3–6 seconds"));
});

test("every step x format composes a non-empty string including SOURCE_RULES", () => {
  for (const step of STEPS) {
    for (const format of FILM_FORMATS) {
      const composed = composeInstructions(step, format);
      assert.ok(composed.length > 0, `${step}/${format} should be non-empty`);
      assert.ok(composed.startsWith(SOURCE_RULES), `${step}/${format} should start with SOURCE_RULES`);
      assert.ok(composed.includes(SOURCE_RULES), `${step}/${format} should include SOURCE_RULES`);
    }
  }
});
