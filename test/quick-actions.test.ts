import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSpecialists } from "../src/lib/agents/router.ts";
import { SPECIALIST_IDS } from "../src/lib/agents/types.ts";
import { ENGAGEMENT_ENTRY_LABEL } from "../src/lib/engagement.ts";
import {
  ENGAGEMENT_ACTION,
  EXPERT_ACTIONS,
  EXPERT_MENU_LABEL,
  FULL_REVIEW_ACTION,
  ORIGINALITY_ACTION,
  QUICK_ACTIONS,
  REPORT_ACTIONS,
  reportName,
  reportTitle,
  showEngagementAction,
  showOriginalityAction,
  showReportAction,
} from "../src/lib/quick-actions.ts";
import { createSession } from "../src/lib/session.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";

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

test("the originality chip is its own entry and shows only once a plan exists", () => {
  assert.ok(!QUICK_ACTIONS.some((action) => action.label === ORIGINALITY_ACTION.label));
  assert.equal(ORIGINALITY_ACTION.label, "Check story originality");
  assert.ok(ORIGINALITY_ACTION.tooltip.trim());
  const plan: ShotPlan = { title: "T", logline: "", intent: "", characters: [], locations: [], scenes: [], reviewNotes: [] };
  const session = createSession("Test");
  assert.equal(showOriginalityAction(session), false);
  assert.equal(showOriginalityAction({ ...session, readyToPlan: true }), false);
  assert.equal(showOriginalityAction({ ...session, phase: "refining" }), false);
  assert.equal(showOriginalityAction({ ...session, phase: "refining", plan }), true);
});

test("the Audience Retention Predictor chip shows only once a plan exists, right after the originality chip", () => {
  assert.ok(!QUICK_ACTIONS.some((action) => action.label === ENGAGEMENT_ACTION.label));
  assert.equal(ENGAGEMENT_ACTION.label, ENGAGEMENT_ENTRY_LABEL);
  assert.equal(
    ENGAGEMENT_ACTION.tooltip,
    "An AI estimate of how well each scene could hold attention — not real audience data.",
  );
  assert.deepEqual(
    REPORT_ACTIONS.map((action) => [action.id, action.label, action.tooltip]),
    [
      ["originality", ORIGINALITY_ACTION.label, ORIGINALITY_ACTION.tooltip],
      ["engagement", ENGAGEMENT_ACTION.label, ENGAGEMENT_ACTION.tooltip],
    ],
  );
  const plan: ShotPlan = { title: "T", logline: "", intent: "", characters: [], locations: [], scenes: [], reviewNotes: [] };
  const session = createSession("Test");
  for (const state of [session, { ...session, readyToPlan: true }, { ...session, phase: "refining" as const }]) {
    assert.equal(showEngagementAction(state), false);
    assert.equal(showReportAction("engagement", state), false);
  }
  const planned = { ...session, phase: "refining" as const, plan };
  assert.equal(showEngagementAction(planned), true);
  assert.equal(showReportAction("engagement", planned), true);
  assert.equal(showReportAction("originality", planned), true);
});

const PREVIOUS_CHIP_MESSAGES: Record<string, string> = {
  "Story check":
    "Check that the story is easy to follow and that the characters and their main problem are clear. Just the most important fixes.",
  "Camera ideas":
    "Suggest camera ideas for the few shots that matter most: where to put the camera, how close to get and how to light them.",
  "Sound design":
    "Suggest sound for the scenes that matter most: music, background sounds, everyday noises like footsteps, and when to go quiet.",
  "Editing & pacing":
    "Check the timing of the film: where to cut, how to go from one scene to the next, and which parts feel too slow or rushed. Just the biggest fixes.",
  "Consistency check":
    "Check for mistakes between scenes: do people, clothes, props and places stay the same, and do events happen in the right order? List the biggest ones.",
  "Full review": "Review the whole film and give me your most important notes.",
};

test("the Ask an expert menu lists the five single experts, each with a one-line description", () => {
  assert.equal(EXPERT_MENU_LABEL, "Ask an expert");
  assert.deepEqual(
    EXPERT_ACTIONS.map((action) => [action.label, action.description]),
    [
      ["Story check", "Is the story clear?"],
      ["Camera ideas", "Angles, distance, light"],
      ["Sound design", "Music, sounds, silence"],
      ["Editing & pacing", "Cuts, slow or rushed parts"],
      ["Consistency", "Mistakes between scenes"],
    ],
  );
  for (const action of EXPERT_ACTIONS) {
    assert.notEqual(action.specialists, "all", action.label);
    assert.ok(action.description.length <= 40 && !/\n/.test(action.description), action.label);
  }
  assert.deepEqual(QUICK_ACTIONS, [...EXPERT_ACTIONS, FULL_REVIEW_ACTION]);
  assert.equal(FULL_REVIEW_ACTION.specialists, "all");
});

test("each menu item and Full review send exactly the message the old chip sent", () => {
  const sent = Object.fromEntries(
    [...EXPERT_ACTIONS, FULL_REVIEW_ACTION].map((action) => [
      action.label === "Consistency" ? "Consistency check" : action.label,
      action.message,
    ]),
  );
  assert.deepEqual(sent, PREVIOUS_CHIP_MESSAGES);
});

test("report buttons show a short label but keep the full name as accessible name and tooltip", () => {
  assert.deepEqual(
    REPORT_ACTIONS.map((action) => [action.shortLabel, action.label]),
    [
      ["Originality", "Check story originality"],
      ["Attention", "Audience Retention Predictor"],
    ],
  );
  assert.deepEqual(REPORT_ACTIONS.map(reportName), ["Check story originality", "Attention — Audience Retention Predictor"]);
  for (const action of REPORT_ACTIONS) {
    const name = reportName(action).toLowerCase();
    assert.ok(name.includes(action.shortLabel.toLowerCase()), "visible label is part of the accessible name");
    assert.ok(name.includes(action.label.toLowerCase()), "the full name stays in the accessible name");
    assert.equal(reportTitle(action), `${action.label}. ${action.tooltip}`);
  }
});
