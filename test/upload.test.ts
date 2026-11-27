import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_SOURCE_LIMIT, SOURCE_INLINE_LIMIT, type StorySource, storyForStep } from "../src/lib/source-text.ts";
import { importDocument } from "../src/lib/studio-agent.ts";
import {
  classifyUpload,
  routeLongText,
  sourceNote,
  tooLongForChatMessage,
  UNSUPPORTED_UPLOAD,
} from "../src/lib/upload.ts";

const file = (name: string, type = "") => ({ name, type });

test("classifyUpload sorts documents, images and audio", () => {
  assert.equal(classifyUpload(file("story.txt", "text/plain")), "document");
  assert.equal(classifyUpload(file("02_full-story.PDF", "application/pdf")), "document");
  assert.equal(classifyUpload(file("frame.png", "image/png")), "image");
  assert.equal(classifyUpload(file("frame.JPG")), "image");
  assert.equal(classifyUpload(file("pasted", "image/webp")), "image");
  assert.equal(classifyUpload(file("note.mp3", "audio/mpeg")), "audio");
  assert.equal(classifyUpload(file("note.wav", "audio/wav")), "audio");
  assert.equal(classifyUpload(file("note.m4a", "audio/mp4")), "audio");
  assert.equal(classifyUpload(file("recording.webm", "audio/webm")), "audio");
});

test("classifyUpload rejects unknown files with a clear message", () => {
  for (const name of ["story.docx", "clip.mp4", "README", "archive.zip"]) {
    assert.deepEqual(classifyUpload(file(name)), { error: UNSUPPORTED_UPLOAD });
  }
});

test("routeLongText: discovery always makes a document the source", () => {
  assert.equal(routeLongText({ chars: 120, origin: "document", phase: "discovery", composerLimit: 2_000 }), "source");
  assert.equal(routeLongText({ chars: 90_000, origin: "document", phase: "discovery", composerLimit: 2_000 }), "source");
});

test("routeLongText: discovery keeps a short transcript in the composer and makes a long one the source", () => {
  assert.equal(routeLongText({ chars: 2_000, origin: "transcript", phase: "discovery", composerLimit: 2_000 }), "composer");
  assert.equal(routeLongText({ chars: 2_001, origin: "transcript", phase: "discovery", composerLimit: 2_000 }), "source");
});

test("routeLongText: refining uses the composer when it fits and never cuts when it doesn't", () => {
  for (const origin of ["document", "transcript"] as const) {
    assert.equal(routeLongText({ chars: 4_000, origin, phase: "refining", composerLimit: 4_000 }), "composer");
    assert.equal(routeLongText({ chars: 4_001, origin, phase: "refining", composerLimit: 4_000 }), "too-long-for-chat");
  }
  assert.match(tooLongForChatMessage(12_345), /12,345 characters/);
  assert.match(tooLongForChatMessage(12_345), /Start a new chat/);
});

test("sourceNote describes the import in plain words", () => {
  const base = { name: "02_full-story.pdf", kind: "pdf" as const, characters: 12_340, pages: 8 };
  const note = sourceNote(base);
  assert.match(note, /I've read “02_full-story\.pdf” \(12,340 characters, 8 pages\)\./);
  assert.match(note, /only ask about what's missing/);
  assert.doesNotMatch(note, /condensed/);
  assert.match(sourceNote({ ...base, digest: "summary" }), /condensed version for questions; the full text is kept for the plan/);
  assert.match(sourceNote(base, { replaced: "old.txt" }), /replaces “old\.txt”/);
  assert.match(sourceNote(base, { digestFailed: true }), /until you import it again/);
  assert.match(sourceNote({ name: "Voice note", kind: "audio", characters: 3_000 }), /I've transcribed “Voice note” \(3,000 characters\)\./);
});

function longStory(characters: number): string {
  const paragraph = "The keeper climbs the stairs at dusk and lights the lamp again. ";
  let text = "";
  while (text.length < characters) text += `${paragraph.repeat(20).trim()}\n\n`;
  return `${text.slice(0, characters - 10)}FINAL-LINE`;
}

function sourceOf(text: string, digest?: string): StorySource {
  return { name: "02_full-story.pdf", kind: "pdf", characters: text.length, text, digest, pages: 40 };
}

test("a long source sends the whole digest for questions and never a cut of the text", () => {
  const text = longStory(100_000);
  const digest = `Condensed story. ${"Beat. ".repeat(2_000)}END-OF-DIGEST`;
  for (const step of ["interview", "plan"] as const) {
    const result = storyForStep("The Lighthouse", sourceOf(text, digest), step);
    assert.ok(result.ok);
    assert.equal(result.condensed, true);
    assert.ok(result.story.endsWith("END-OF-DIGEST"));
    assert.ok(result.story.includes(digest));
    assert.ok(!result.story.includes(text.slice(0, 2_000)), `${step} must not carry a truncated copy of the text`);
  }
});

test("a mid-size source goes to the plan in full and to questions as the digest", () => {
  const text = longStory(SOURCE_INLINE_LIMIT + 10_000);
  assert.ok(text.length < PLAN_SOURCE_LIMIT);
  const source = sourceOf(text, "Condensed story.");
  const plan = storyForStep("The Lighthouse", source, "plan");
  assert.ok(plan.ok);
  assert.equal(plan.condensed, false);
  assert.ok(plan.story.endsWith("FINAL-LINE"));
  assert.ok(plan.story.includes(text));
  const interview = storyForStep("The Lighthouse", source, "interview");
  assert.ok(interview.ok);
  assert.equal(interview.condensed, true);
});

test("a long source without a digest fails loudly instead of truncating", () => {
  const result = storyForStep("The Lighthouse", sourceOf(longStory(SOURCE_INLINE_LIMIT + 1)), "interview");
  assert.equal(result.ok, false);
});

test("importDocument returns the whole TXT file, not the old 2,000/4,000/60,000-character cut", async () => {
  const text = longStory(80_000);
  const result = await importDocument(new File([text], "story.txt", { type: "text/plain" }));
  assert.ok(result.ok);
  assert.equal(result.characters, 80_000);
  assert.ok(result.text.endsWith("FINAL-LINE"));
  assert.equal(result.pages, undefined);
});

test("importDocument rejects unreadable and empty TXT files with clear messages", async () => {
  const binary = await importDocument(new File([new Uint8Array([0xc3, 0x28, 0xff, 0xfe])], "story.txt"));
  assert.equal(binary.ok, false);
  const empty = await importDocument(new File(["   \n  "], "blank.txt"));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /“blank\.txt” has no readable text/);
});

test("a saved session with a malformed story source still loads, without the bad source", async () => {
  const { parseSessions, isStorySource } = await import("@/lib/session");
  const good = { id: "a", title: "A boy", createdAt: 1, updatedAt: 1, phase: "discovery", readyToPlan: false, pendingQuestion: null, answered: [], collected: [], messages: [], plan: null, usage: [] };
  const raw = JSON.stringify({ version: 1, activeId: "a", sessions: [{ ...good, source: { name: "x.pdf", kind: "pdf" } }] });
  const loaded = parseSessions(raw);
  assert.equal(loaded.sessions.length, 1);
  assert.equal(loaded.sessions[0].source, undefined);
  assert.equal(isStorySource({ name: "x.txt", kind: "txt", text: "hi", characters: 2 }), true);
});
