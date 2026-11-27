import assert from "node:assert/strict";
import { test } from "node:test";
import { FILM_FORMATS } from "../src/lib/formats.ts";
import { composeInstructions, SOURCE_RULES, SOURCE_STORY_RULE, SUGGESTED_CONCEPT_RULE } from "../src/lib/server/prompts.ts";
import { MAX_PLAN_SCENES, MAX_RENAMES } from "../src/lib/story-planning.ts";

const STEPS = ["draft", "interview", "plan_outline", "plan_scene", "edit_plan", "edit_scene"] as const;

test("composeInstructions is deterministic and starts with SOURCE_RULES", () => {
  const first = composeInstructions("plan_outline", "short_film");
  const second = composeInstructions("plan_outline", "short_film");
  assert.equal(first, second);
  assert.ok(first.startsWith(SOURCE_RULES));
});

test("every step x format composes a non-empty string including SOURCE_RULES and a format line", () => {
  for (const step of STEPS) {
    for (const format of FILM_FORMATS) {
      const composed = composeInstructions(step, format);
      assert.ok(composed.length > 0, `${step}/${format} should be non-empty`);
      assert.ok(composed.startsWith(SOURCE_RULES), `${step}/${format} should start with SOURCE_RULES`);
      assert.ok(!composed.includes("undefined"), `${step}/${format}`);
      assert.notEqual(composed.split("\n").at(-1), "", `${step}/${format} has a format line`);
    }
  }
});

test("plan_outline carries the binding decisions, review-note labels and the suggested-concept note", () => {
  const composed = composeInstructions("plan_outline", "short_film");
  assert.ok(composed.includes("interview answers"));
  assert.ok(composed.includes("collected creative details"));
  assert.ok(composed.includes("approved true as binding"));
  assert.ok(composed.includes('"Assumption:"'));
  assert.ok(composed.includes('"Suggestion:"'));
  assert.ok(composed.includes(SUGGESTED_CONCEPT_RULE));
  assert.ok(composed.includes("so they can confirm or change them"));
  assert.ok(composed.includes(`at most ${MAX_PLAN_SCENES}`));
  assert.ok(!composed.includes("original dialogue"));
  assert.ok(!composed.includes("3–6 seconds"));
});

test("plan_scene carries the dialogue and shot rules and writes one scene from the outline", () => {
  const composed = composeInstructions("plan_scene", "short_film");
  assert.ok(composed.includes("original dialogue"));
  assert.ok(composed.includes("without surrounding quotation marks"));
  assert.ok(composed.includes("Split dialogue interrupted by action"));
  assert.ok(composed.includes("empty dialogue array"));
  assert.ok(composed.includes("character and location names exactly as written"));
  assert.ok(composed.includes("3–6 seconds"));
  assert.ok(composed.includes("ONE scene"));
  assert.ok(!composed.includes('"Assumption:"'));
  assert.ok(!composed.includes(SUGGESTED_CONCEPT_RULE));
  assert.ok(!composed.includes("copy one contiguous spoken fragment exactly"));
});

test("edit_plan decides the change, confirms it in plain words and asks for Apply", () => {
  const composed = composeInstructions("edit_plan", "short_film");
  assert.ok(composed.includes("This call is step 1: decide exactly what changes"));
  assert.ok(composed.includes("ending by asking them to press Apply"));
  assert.ok(composed.includes("never say it is done"));
  assert.ok(composed.includes("When the message is a question, a review or needs no change, answer it in reply and return no change"));
  assert.ok(composed.includes("from (the name exactly as written in plan.characters or plan.locations)"));
  assert.ok(composed.includes("never rewrite a scene just to change a name"));
  assert.ok(composed.includes(`at most ${MAX_RENAMES}`));
  assert.ok(composed.includes(`At most ${MAX_PLAN_SCENES} rewrites and inserts`));
  assert.ok(composed.includes("-1 to put it first"));
  assert.ok(composed.includes("Every index refers to the plan as sent"));
  assert.ok(composed.includes("hints.namedScenes"));
  assert.ok(composed.includes("Never re-propose a change the filmmaker rejected unless the new message asks for it again"));
  assert.ok(composed.includes("build on accepted changes"));
  assert.ok(composed.includes(SOURCE_STORY_RULE));
  assert.ok(composed.includes("overrides the source"));
  assert.ok(!composed.includes("original dialogue"));
  assert.ok(!composed.includes("sceneEdits"));
});

test("edit_scene writes ONE complete scene, keeps what the instruction doesn't touch and uses the new names", () => {
  const composed = composeInstructions("edit_scene", "short_film");
  assert.ok(composed.includes("this call writes ONE scene"));
  assert.ok(composed.includes("Return the complete scene"));
  assert.ok(composed.includes("keep everything it doesn't touch exactly as it is"));
  assert.ok(composed.includes("always use the new name"));
  assert.ok(composed.includes("Keep continuity with the neighbouring scenes"));
  assert.ok(composed.includes("original dialogue"));
  assert.ok(composed.includes("3–6 seconds"));
  assert.ok(composed.includes(SOURCE_STORY_RULE));
  assert.ok(!composed.includes("press Apply"));
});
