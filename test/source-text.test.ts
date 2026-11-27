import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkSourceText,
  chunkText,
  DIGEST_CHUNK_TARGET,
  decodeTextFile,
  MAX_DIGEST_CHUNKS,
  MAX_SOURCE_CHARACTERS,
  normalizeSourceText,
  PLAN_SOURCE_LIMIT,
  SOURCE_INLINE_LIMIT,
  type StorySource,
  storyForStep,
} from "../src/lib/source-text.ts";

const words = (text: string) => text.split(/\s+/).filter(Boolean);

function longStory(length: number): string {
  const paragraphs: string[] = [];
  let total = 0;
  for (let p = 0; total < length; p++) {
    const sentences = Array.from(
      { length: 2 + (p % 11) },
      (_, s) => `Mara${p} passes door ${s} and whispers "wait," then runs on.`,
    );
    const paragraph = sentences.join(" ");
    paragraphs.push(paragraph);
    total += paragraph.length + 2;
  }
  return paragraphs.join("\n\n").slice(0, length).trim();
}

function source(text: string, digest?: string): StorySource {
  return { name: "novel.pdf", kind: "pdf", characters: text.length, text, digest };
}

test("normalisation keeps every word and strips control characters", () => {
  const raw = "﻿First line\u0007 \r\nSecond\tline\u0000\rThird\u001F line\u007F\n\n\n\n\nLast  line   ";
  const text = normalizeSourceText(raw);
  assert.equal(text, "First line\nSecond\tline\nThird line\n\nLast  line");
  assert.deepEqual(words(text), ["First", "line", "Second", "line", "Third", "line", "Last", "line"]);
  assert.doesNotMatch(text, /\r|﻿/);
});

test("checkSourceText rejects empty, garbled and too-long text with plain messages", () => {
  assert.deepEqual(checkSourceText("  \u0001\n\t ", "This PDF"), { ok: false, error: "This PDF has no readable text." });

  const garbled = checkSourceText(`Story ${"�".repeat(50)}`, "This file");
  assert.equal(garbled.ok, false);
  assert.match(garbled.ok ? "" : garbled.error, /^This file isn't readable text\./);
  assert.ok(checkSourceText(`A real story with a few odd marks �� ${"word ".repeat(200)}`, "This file").ok);

  const tooLong = checkSourceText("a".repeat(MAX_SOURCE_CHARACTERS + 1), "This PDF");
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.ok ? "" : tooLong.error, /^This PDF is too long \(300,001 characters\)\. The limit is 300,000/);

  const atLimit = checkSourceText("a".repeat(MAX_SOURCE_CHARACTERS), "This PDF");
  assert.deepEqual(atLimit, { ok: true, text: "a".repeat(MAX_SOURCE_CHARACTERS) });
});

test("decodeTextFile reads UTF-8 and UTF-16 with a BOM and rejects invalid bytes", () => {
  assert.deepEqual(decodeTextFile(new TextEncoder().encode("Café — “quoted”")), { ok: true, text: "Café — “quoted”" });

  const utf16le = Uint8Array.from([0xff, 0xfe, ...Buffer.from("Héllo", "utf16le")]);
  assert.deepEqual(decodeTextFile(utf16le), { ok: true, text: "Héllo" });

  const utf16be = Uint8Array.from([0xfe, 0xff, ...Buffer.from("Hi", "utf16le").swap16()]);
  assert.deepEqual(decodeTextFile(utf16be), { ok: true, text: "Hi" });

  const invalid = decodeTextFile(Uint8Array.from([0x48, 0x69, 0xc3, 0x28, 0xff]));
  assert.deepEqual(invalid, { ok: false, error: "This text file isn't UTF-8. Re-save it as UTF-8 text and try again." });

  const binary = decodeTextFile(Uint8Array.from([0x48, 0x00, 0x69]));
  assert.equal(binary.ok, false);
  assert.match(binary.ok ? "" : binary.error, /isn't plain text/);
});

test("chunkText is lossless and makes at most 8 chunks for a 300,000-character story", () => {
  const text = longStory(MAX_SOURCE_CHARACTERS);
  assert.ok(text.length > MAX_SOURCE_CHARACTERS - 100);
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1 && chunks.length <= MAX_DIGEST_CHUNKS, `chunks: ${chunks.length}`);
  assert.ok(chunks.every((chunk) => chunk.trim().length > 0));
  assert.deepEqual(words(chunks.join("\n\n")), words(text));
});

test("chunkText keeps short text whole and splits medium text near the target size", () => {
  assert.deepEqual(chunkText("One paragraph.\n\nTwo paragraph."), ["One paragraph.\n\nTwo paragraph."]);

  const text = longStory(50_000);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 4 && chunks.length <= MAX_DIGEST_CHUNKS, `chunks: ${chunks.length}`);
  assert.ok(chunks.every((chunk) => chunk.length <= DIGEST_CHUNK_TARGET + 1_000));
  assert.deepEqual(words(chunks.join("\n\n")), words(text));
});

test("chunkText splits one huge unpunctuated paragraph without losing characters", () => {
  const text = Array.from({ length: 50_000 }, (_, index) => `w${index}`).join(" ");
  const chunks = chunkText(text);
  assert.ok(chunks.length <= MAX_DIGEST_CHUNKS);
  assert.equal(chunks.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("storyForStep sends the full source when it fits that step's limit", () => {
  assert.deepEqual(storyForStep("  The Letter ", undefined, "interview"), { ok: true, story: "The Letter", condensed: false });

  const short = source("Mara finds a letter under the door.");
  for (const step of ["interview", "plan"] as const) {
    const result = storyForStep("The Letter", short, step);
    assert.ok(result.ok);
    assert.equal(result.condensed, false);
    assert.equal(result.story, "The Letter\n\nStory source (novel.pdf):\nMara finds a letter under the door.");
  }
});

test("storyForStep uses the digest above the limit, with separate interview and plan limits", () => {
  const medium = longStory(SOURCE_INLINE_LIMIT + 5_000);
  assert.ok(medium.length < PLAN_SOURCE_LIMIT - 200);
  const withDigest = source(medium, "Part 1 of 3\nWhat happens:\n- Mara finds the letter.");

  const interview = storyForStep("The Letter", withDigest, "interview");
  assert.ok(interview.ok);
  assert.equal(interview.condensed, true);
  assert.match(interview.story, /condensed from [\d,]+ characters/);
  assert.match(interview.story, /Part 1 of 3/);
  assert.ok(!interview.story.includes(medium.slice(0, 200)));

  const plan = storyForStep("The Letter", withDigest, "plan");
  assert.ok(plan.ok);
  assert.equal(plan.condensed, false);
  assert.ok(plan.story.endsWith(medium));

  const huge = source(longStory(PLAN_SOURCE_LIMIT + 1_000), "Part 1 of 8\nWhat happens:\n- Everything.");
  const hugePlan = storyForStep("The Letter", huge, "plan");
  assert.ok(hugePlan.ok);
  assert.equal(hugePlan.condensed, true);
});

test("storyForStep fails instead of truncating when no digest exists", () => {
  const result = storyForStep("The Letter", source(longStory(SOURCE_INLINE_LIMIT + 1_000)), "interview");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /“novel\.pdf” is too long to send in full/);
  assert.ok(storyForStep("The Letter", source(longStory(SOURCE_INLINE_LIMIT + 1_000)), "plan").ok);
});

test("chunking keeps leading punctuation and every character of very long paragraphs", async () => {
  const { chunkText } = await import("@/lib/source-text");
  const sentence = "...And then he ran! \"Wait,\" she said. Why? ";
  const paragraph = sentence.repeat(1200).trim();
  const chunks = chunkText(paragraph, 2_000, 8);
  const squash = (text: string) => text.replace(/\s+/g, "");
  assert.equal(squash(chunks.join(" ")), squash(paragraph));
  assert.ok(chunks.length <= 8);
});

test("audio extensions ignore inherited object keys", async () => {
  const { audioExtensionOf, validateAudioFile } = await import("@/lib/audio");
  assert.equal(audioExtensionOf("x.constructor"), null);
  assert.equal(validateAudioFile({ name: "x.toString", type: "", size: 10 }).ok, false);
});
