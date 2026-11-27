import assert from "node:assert/strict";
import { test } from "node:test";
import { FILM_FORMATS } from "../src/lib/formats.ts";
import {
  ANALYSIS_STYLE,
  composeInstructions,
  DIRECTOR_PERSONA,
  DISCOVERY_STYLE,
  PLAIN_LANGUAGE,
  SOURCE_RULES,
} from "../src/lib/server/prompts.ts";

const STEPS = ["draft", "interview", "plan", "refine"] as const;
const ANALYSIS_STEPS = ["draft", "plan", "refine"] as const;

test("every stage and format carries the one Creative Director persona", () => {
  for (const step of STEPS) {
    for (const format of FILM_FORMATS) {
      const composed = composeInstructions(step, format);
      assert.ok(composed.includes(DIRECTOR_PERSONA), `${step}/${format}`);
      assert.equal(composed.split(DIRECTOR_PERSONA).length - 1, 1, `${step}/${format} persona once`);
    }
  }
});

test("composition order: source rules, persona, plain language, style, then stage text", () => {
  for (const step of STEPS) {
    const composed = composeInstructions(step, "short_film");
    const style = step === "interview" ? DISCOVERY_STYLE : ANALYSIS_STYLE;
    assert.ok(composed.startsWith([SOURCE_RULES, DIRECTOR_PERSONA, PLAIN_LANGUAGE, style].join("\n")), step);
  }
});

test("interview uses the discovery style and never the analysis style", () => {
  const composed = composeInstructions("interview", "short_film");
  assert.ok(composed.includes(DISCOVERY_STYLE));
  assert.ok(!composed.includes(ANALYSIS_STYLE));
});

test("draft, plan and refine use the analysis style and never the discovery style", () => {
  for (const step of ANALYSIS_STEPS) {
    const composed = composeInstructions(step, "short_film");
    assert.ok(composed.includes(ANALYSIS_STYLE), step);
    assert.ok(!composed.includes(DISCOVERY_STYLE), step);
  }
});

test("stage texts do not restate a second identity", () => {
  for (const step of STEPS) {
    const composed = composeInstructions(step, "short_film").replace(DIRECTOR_PERSONA, "");
    assert.ok(!/\bYou are an?\b/i.test(composed), step);
  }
});
