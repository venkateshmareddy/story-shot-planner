import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDecisionHistory,
  MAX_DECISION_CHANGE,
  MAX_DECISION_CHANGES,
  MAX_DECISION_REQUEST,
} from "../src/lib/decisions.ts";
import type { ChatMessage } from "../src/lib/session.ts";
import { MAX_DECISIONS } from "../src/lib/story-planning.ts";

let nextId = 0;
const user = (text: string): ChatMessage => ({ id: `u${++nextId}`, role: "user", text });
const agent = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `a${++nextId}`,
  role: "agent",
  text,
  ...extra,
});

test("pairs each resolved proposal with the request before it, oldest first", () => {
  const history = buildDecisionHistory([
    agent("Your shot plan is ready."),
    user("Make the opening slower"),
    agent("Slower opening proposed.", { status: "accepted", changeSummary: ["S01_SH01 now 8 seconds"] }),
    user("Add a drone shot"),
    agent("Drone shot proposed.", { status: "rejected", changeSummary: ["Added S02_SH05 aerial"] }),
  ]);
  assert.deepEqual(history, [
    { status: "accepted", request: "Make the opening slower", changes: ["S01_SH01 now 8 seconds"] },
    { status: "rejected", request: "Add a drone shot", changes: ["Added S02_SH05 aerial"] },
  ]);
});

test("ignores pending proposals and advice-only replies", () => {
  const history = buildDecisionHistory([
    user("What lens for scene 2?"),
    agent("Try a 35mm.", { recommendations: [] }),
    user("Cut the second scene"),
    agent("Cut proposed.", { status: "pending", changeSummary: ["Removed scene 2"] }),
  ]);
  assert.deepEqual(history, []);
});

test("clips the request and changes to the server limits; missing changes become []", () => {
  const history = buildDecisionHistory([
    user(`  ${"r".repeat(MAX_DECISION_REQUEST + 50)}  `),
    agent("Proposed.", {
      status: "accepted",
      changeSummary: [...Array.from({ length: MAX_DECISION_CHANGES + 3 }, () => "c".repeat(MAX_DECISION_CHANGE + 20)), "   "],
    }),
    user("Brighter"),
    agent("Proposed.", { status: "rejected" }),
  ]);
  assert.equal(history[0].request.length, MAX_DECISION_REQUEST);
  assert.equal(history[0].changes.length, MAX_DECISION_CHANGES);
  assert.ok(history[0].changes.every((change) => change.length === MAX_DECISION_CHANGE));
  assert.deepEqual(history[1], { status: "rejected", request: "Brighter", changes: [] });
});

test(`keeps only the last ${MAX_DECISIONS} decisions`, () => {
  const messages = Array.from({ length: MAX_DECISIONS + 5 }, (_, index) => [
    user(`request ${index}`),
    agent("Proposed.", { status: index % 2 === 0 ? "accepted" : "rejected", changeSummary: [`change ${index}`] }),
  ]).flat();
  const history = buildDecisionHistory(messages);
  assert.equal(history.length, MAX_DECISIONS);
  assert.equal(history[0].request, "request 5");
  assert.equal(history.at(-1)?.request, `request ${MAX_DECISIONS + 4}`);
});
