import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SPECIALISTS, SYNTHESIS_INSTRUCTIONS } from "../src/lib/agents/orchestrator.ts";
import { FILM_FORMATS } from "../src/lib/formats.ts";
import {
  BRAIN_DIR,
  brainFile,
  brainSections,
  renderBrainText,
  splitBrainSections,
  stripEditorNotes,
} from "../src/lib/server/brain.ts";
import { DIGEST_INSTRUCTIONS } from "../src/lib/server/digest.ts";
import { IMAGE_ANALYSIS_INSTRUCTIONS } from "../src/lib/server/image-analysis.ts";
import { composeInstructions, STAGES } from "../src/lib/server/prompts.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "brain-instructions.json");

/** Every fixed instruction string the app sends, by call. */
function finalInstructions(): Record<string, string> {
  const all: Record<string, string> = {};
  for (const stage of STAGES) {
    for (const format of FILM_FORMATS) all[`stage:${stage}:${format}`] = composeInstructions(stage, format);
  }
  for (const [id, definition] of Object.entries(SPECIALISTS)) all[`specialist:${id}`] = definition.instructions;
  all["image-analysis"] = IMAGE_ANALYSIS_INSTRUCTIONS;
  all.digest = DIGEST_INSTRUCTIONS;
  all.synthesis = SYNTHESIS_INSTRUCTIONS;
  return all;
}

function brainFiles(dir = BRAIN_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? brainFiles(full) : [path.relative(BRAIN_DIR, full)];
  });
}

test("every instruction string equals the approved fixture (UPDATE_BRAIN_FIXTURE=1 accepts an intended change)", (t) => {
  const actual = finalInstructions();
  if (process.env.UPDATE_BRAIN_FIXTURE === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    t.diagnostic("brain fixture updated");
    return;
  }
  const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [name, text] of Object.entries(expected)) assert.equal(actual[name], text, `${name} drifted`);
});

test("every placeholder is filled and no editor note or title reaches the model", () => {
  for (const [name, text] of Object.entries(finalInstructions())) {
    assert.ok(!/\{\{|\}\}/.test(text), `${name} has an unfilled placeholder`);
    assert.ok(!text.includes("<!--") && !/^# /m.test(text), `${name} carries a note or title`);
    assert.ok(!text.includes("\n\n") && text === text.trim(), `${name} has blank lines`);
  }
});

test("the brain folder holds only Markdown, and every file but README reaches a prompt", () => {
  const files = brainFiles();
  assert.ok(files.length >= 30, `${files.length} brain files`);
  const prompts = Object.values(finalInstructions()).join("\n");
  for (const file of files) {
    assert.equal(path.extname(file), ".md", file);
    if (file === "README.md") continue;
    const markdown = readFileSync(path.join(BRAIN_DIR, file), "utf8");
    const body = stripEditorNotes(markdown);
    const blocks = /^## /m.test(body) ? Object.values(splitBrainSections(markdown, file)) : [body];
    for (const block of blocks) {
      const pieces = block
        .split(/\{\{[A-Z0-9_]+\}\}/)
        .flatMap((piece) => piece.split("\n"))
        .map((piece) => piece.trim())
        .filter(Boolean);
      assert.ok(pieces.length, `${file} has an empty block`);
      for (const piece of pieces) assert.ok(prompts.includes(piece), `${file}: "${piece.slice(0, 60)}" reaches no prompt`);
    }
  }
});

test("every stage and format has its brain file, and every format covers every stage", () => {
  const files = new Set(brainFiles());
  for (const stage of STAGES) assert.ok(files.has(path.join("stages", `${stage}.md`)), stage);
  for (const format of FILM_FORMATS) {
    assert.deepEqual(Object.keys(brainSections(`formats/${format}.md`)), [...STAGES], format);
  }
  for (const id of Object.keys(SPECIALISTS)) {
    assert.deepEqual(Object.keys(brainSections(`experts/${id}.md`, { SOURCE_STORY_RULE: "x" })), [
      "role",
      "scope",
      "expertise",
      "checklist",
      "fields",
    ]);
  }
});

test("renderBrainText drops notes and the title, fills placeholders and keeps one line per paragraph", () => {
  const markdown = "# Title for people\n<!-- a note\nover two lines -->\nFirst {{N}} line.  \n\n\nSecond {{WORD}}.\n<!-- end -->\n";
  assert.equal(renderBrainText(markdown, { N: 3, WORD: "line" }), "First 3 line.\nSecond line.");
  assert.equal(renderBrainText("Not a title: # here\n"), "Not a title: # here");
  assert.equal(renderBrainText("A {{X}}.", { X: "{{Y}}" }), "A {{Y}}.", "filled values are not filled again");
});

test("renderBrainText throws on a missing placeholder value or an empty file", () => {
  assert.throws(() => renderBrainText("Up to {{MAX}} items.", {}, "x.md"), /x\.md: no value for \{\{MAX\}\}/);
  assert.throws(() => renderBrainText("# Only a title\n<!-- and a note -->\n", {}, "y.md"), /y\.md is empty/);
});

test("splitBrainSections keeps sections in order and rejects stray text and duplicates", () => {
  const sections = splitBrainSections("# T\n<!-- n -->\n## one\nA\n\n## two  \nB\nC\n");
  assert.deepEqual(Object.keys(sections), ["one", "two"]);
  assert.equal(sections.two.trim(), "B\nC");
  assert.throws(() => splitBrainSections("Loose text\n## one\nA\n", "z.md"), /z\.md: text before the first ## section/);
  assert.throws(() => splitBrainSections("## one\nA\n## one\nB\n", "z.md"), /duplicate section "one"/);
  assert.throws(() => splitBrainSections("No sections\n", "z.md"), /has no ## sections/);
});

test("brain files can only be Markdown inside the brain folder", () => {
  assert.throws(() => brainFile("../../../package.json"), /Not a brain file/);
  assert.throws(() => brainFile("../creative-director-copy/SAFETY.md"), /Not a brain file/);
  assert.throws(() => brainFile("README"), /Not a brain file/);
  assert.throws(() => brainFile("stages/missing.md"), /ENOENT/);
  assert.equal(brainFile("SAFETY.md"), finalInstructions()["image-analysis"].split("\n")[0]);
});
