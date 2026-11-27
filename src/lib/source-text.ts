// Imported story sources (TXT, PDF, long voice notes). Pure and client-safe.
import { MAX_STORY_CHARACTERS } from "./story-input";
import type { UsageRecord } from "./usage";

/** Hard cap for one imported source (~120 pages). Longer input is rejected with a clear message, never cut. */
export const MAX_SOURCE_CHARACTERS = 300_000;
/** Interview turns send the full source up to this size; above it they send the digest. */
export const SOURCE_INLINE_LIMIT = 24_000;
/** Plan generation sends the full source up to this size (the story field limit); above it, the digest. */
export const PLAN_SOURCE_LIMIT = MAX_STORY_CHARACTERS;
export const DIGEST_CHUNK_TARGET = 12_000;
export const MAX_DIGEST_CHUNKS = 8;
/** The assembled digest stays below the interview inline limit. */
export const MAX_DIGEST_CHARACTERS = 22_000;

export type SourceKind = "txt" | "pdf" | "audio";

export type StorySource = {
  name: string;
  kind: SourceKind;
  /** Character count of the full normalised text. */
  characters: number;
  /** The full normalised text, never truncated. */
  text: string;
  /** Structured condensed version, present when the text exceeds SOURCE_INLINE_LIMIT. */
  digest?: string;
  pages?: number;
};

/** POST /api/story/digest — body {name, text}; response: */
export type DigestResponse = { digest: string; chunks: number; usage: UsageRecord[] };

export type SourceCheck = { ok: true; text: string } | { ok: false; error: string };

/** Normalise line endings and whitespace and strip control characters. Keeps every word. */
export function normalizeSourceText(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Validate extracted text: non-empty, mostly readable, within the hard cap. */
export function checkSourceText(raw: string, label: string): SourceCheck {
  const text = normalizeSourceText(raw);
  if (!text) return { ok: false, error: `${label} has no readable text.` };
  const replacement = (text.match(/�/g) ?? []).length;
  if (replacement > Math.max(20, text.length * 0.02)) {
    return { ok: false, error: `${label} isn't readable text. Save it as UTF-8 text or a PDF with selectable text.` };
  }
  if (text.length > MAX_SOURCE_CHARACTERS) {
    return {
      ok: false,
      error: `${label} is too long (${text.length.toLocaleString("en")} characters). The limit is ${MAX_SOURCE_CHARACTERS.toLocaleString("en")} (about 120 pages) — import a shorter part.`,
    };
  }
  return { ok: true, text };
}

/** Decode a TXT file's bytes: UTF-8 (strict) or UTF-16 with a byte-order mark. */
export function decodeTextFile(bytes: Uint8Array): SourceCheck {
  try {
    let text: string;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    else text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) return { ok: false, error: "This file isn't plain text. Choose a .txt file or a PDF." };
    return { ok: true, text };
  } catch {
    return { ok: false, error: "This text file isn't UTF-8. Re-save it as UTF-8 text and try again." };
  }
}

/**
 * Split text into at most `maxChunks` chunks on paragraph (then sentence) boundaries.
 * Lossless: joining the chunks with "\n\n" reproduces every word of the input.
 */
export function chunkText(text: string, target = DIGEST_CHUNK_TARGET, maxChunks = MAX_DIGEST_CHUNKS): string[] {
  const size = Math.max(target, Math.ceil(text.length / maxChunks));
  const paragraphs = text.split(/\n{2,}/).flatMap((paragraph) => splitLong(paragraph, size));
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  while (chunks.length > maxChunks) {
    const last = chunks.pop() as string;
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${last}`;
  }
  return chunks;
}

function splitLong(paragraph: string, size: number): string[] {
  if (paragraph.length <= size) return [paragraph];
  // Split on the whitespace after sentence-ending punctuation, so no character other than that whitespace is lost.
  const sentences = paragraph.split(/(?<=[.!?]["')\]]*)\s+/).filter(Boolean);
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > size) {
      parts.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) parts.push(current);
  return parts.flatMap((part) =>
    part.length <= size ? [part] : Array.from({ length: Math.ceil(part.length / size) }, (_, i) => part.slice(i * size, (i + 1) * size)),
  );
}

export function needsDigest(source: Pick<StorySource, "characters">): boolean {
  return source.characters > SOURCE_INLINE_LIMIT;
}

export type StoryInput = { ok: true; story: string; condensed: boolean } | { ok: false; error: string };

/** Marks the start of an imported story inside the `story` text; without it, `story` is only the working title. */
export const STORY_SOURCE_MARKER = "Story source (";

export function hasStorySource(story: string): boolean {
  return story.includes(`\n\n${STORY_SOURCE_MARKER}`);
}

/**
 * The `story` text for an interview or plan request: the title plus the full source when it fits that step's
 * limit, otherwise the digest. Never silently truncates: if the source is too long and no digest exists, it fails.
 */
export function storyForStep(title: string, source: StorySource | undefined, step: "interview" | "plan"): StoryInput {
  const heading = title.trim();
  if (!source) return { ok: true, story: heading, condensed: false };
  const limit = step === "interview" ? SOURCE_INLINE_LIMIT : PLAN_SOURCE_LIMIT;
  const intro = `${heading}\n\n${STORY_SOURCE_MARKER}${source.name}):\n`;
  if (source.text.length + intro.length <= limit) return { ok: true, story: `${intro}${source.text}`, condensed: false };
  if (source.digest) {
    return { ok: true, story: `${heading}\n\n${STORY_SOURCE_MARKER}${source.name}, condensed from ${source.characters.toLocaleString("en")} characters):\n${source.digest}`, condensed: true };
  }
  return { ok: false, error: `“${source.name}” is too long to send in full and its condensed version isn't ready. Re-import it to try again.` };
}
