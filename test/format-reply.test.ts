import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReply } from "../src/lib/format-reply.ts";

test("a single line is one paragraph", () => {
  assert.deepEqual(formatReply("Keep the opening wide."), [{ type: "paragraph", text: "Keep the opening wide." }]);
});

test("empty or blank text produces no blocks", () => {
  assert.deepEqual(formatReply(""), []);
  assert.deepEqual(formatReply("  \n\n "), []);
});

test("a label followed by bullets becomes a label block and a list", () => {
  assert.deepEqual(formatReply("Camera:\n- Start on a wide shot\n- Push in slowly"), [
    { type: "label", text: "Camera:" },
    { type: "list", items: ["Start on a wide shot", "Push in slowly"] },
  ]);
});

test("blank lines separate paragraphs; single newlines stay inside one paragraph", () => {
  assert.deepEqual(formatReply("First idea.\nStill the first.\n\nSecond idea."), [
    { type: "paragraph", text: "First idea.\nStill the first." },
    { type: "paragraph", text: "Second idea." },
  ]);
});

test("• bullets form a list, and blank lines between bullets keep one list", () => {
  assert.deepEqual(formatReply("• Low key light\n\n• Warm practicals"), [
    { type: "list", items: ["Low key light", "Warm practicals"] },
  ]);
});

test("long lines ending in a colon stay paragraphs", () => {
  const line = "Here is everything I would change in the second scene to make it land:";
  assert.deepEqual(formatReply(line), [{ type: "paragraph", text: line }]);
});

test("markdown bold and headings do not leak", () => {
  const blocks = formatReply("## Sound\n**Camera:**\n- Use a **handheld** rig\nThis is **important**.");
  assert.deepEqual(blocks, [
    { type: "label", text: "Sound" },
    { type: "label", text: "Camera:" },
    { type: "list", items: ["Use a handheld rig"] },
    { type: "paragraph", text: "This is important." },
  ]);
  assert.ok(!JSON.stringify(blocks).includes("**"));
});
