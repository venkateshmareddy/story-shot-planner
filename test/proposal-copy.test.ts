import assert from "node:assert/strict";
import { test } from "node:test";
import { proposalConfirmation } from "../src/lib/proposal-copy.ts";

test("confirmation without a change list still asks to apply or discard", () => {
  const expected = "Ready to update your story. Apply to make this change, or Discard to keep your story as it is.";
  assert.equal(proposalConfirmation(undefined), expected);
  assert.equal(proposalConfirmation([]), expected);
});

test("confirmation for one change is singular", () => {
  assert.equal(
    proposalConfirmation(["Scene 2 now opens at dawn"]),
    "Ready to update your story: 1 change. Apply to make it, or Discard to keep your story as it is.",
  );
});

test("confirmation for several changes is plural and counts them", () => {
  assert.equal(
    proposalConfirmation(["Shot 1A is wider", "Scene 3 removed", "New logline"]),
    "Ready to update your story: 3 changes. Apply to make them, or Discard to keep your story as it is.",
  );
});
