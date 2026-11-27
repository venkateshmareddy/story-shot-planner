import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSpecialists } from "../src/lib/agents/router.ts";
import { SPECIALIST_IDS } from "../src/lib/agents/types.ts";
import { QUICK_ACTIONS } from "../src/lib/quick-actions.ts";

test("quick actions have unique, non-empty labels and messages", () => {
  assert.equal(QUICK_ACTIONS.length, 6);
  assert.equal(new Set(QUICK_ACTIONS.map((action) => action.label)).size, QUICK_ACTIONS.length);
  for (const action of QUICK_ACTIONS) {
    assert.ok(action.label.trim());
    assert.ok(action.message.trim());
  }
});

test("quick actions ask for the most important points, not every shot or scene", () => {
  for (const action of QUICK_ACTIONS) {
    assert.doesNotMatch(action.message, /\b(?:each|every|all)\s+(?:of\s+)?(?:the\s+)?(?:shots?|scenes?)\b/i, action.label);
  }
});

for (const action of QUICK_ACTIONS) {
  test(`"${action.label}" routes to its intended specialists`, () => {
    const expected = action.specialists === "all" ? [...SPECIALIST_IDS] : [...action.specialists];
    assert.deepEqual([...selectSpecialists(action.message)].sort(), expected.sort());
  });
}

test("each single-specialist chip covers a different specialist, and Full review covers all five", () => {
  const singles = QUICK_ACTIONS.filter((action) => action.specialists !== "all").flatMap((action) => action.specialists);
  assert.deepEqual([...singles].sort(), [...SPECIALIST_IDS].sort());
  const full = QUICK_ACTIONS.find((action) => action.label === "Full review");
  assert.ok(full);
  assert.deepEqual([...selectSpecialists(full.message)].sort(), [...SPECIALIST_IDS].sort());
});
