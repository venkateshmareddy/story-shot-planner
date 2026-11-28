// Voice-to-text contract shared by the browser and the transcribe route. Pure and client-safe.
import { z } from "zod";
import type { StorySession } from "./session";

export const DEFAULT_GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

export const TRANSCRIBE_HINT_HEADER = "x-transcribe-hint";
export const MAX_HINT_TITLE = 200;
export const MAX_HINT_NAMES = 40;
export const MAX_HINT_NAME = 60;
/** Encoded header budget, well under common 8–16 KB request-header limits. */
export const MAX_HINT_HEADER = 4_096;
export const INVALID_HINT_MESSAGE =
  "The project details sent with the voice note aren’t valid. Reload the page and try again.";

export const transcribeHintSchema = z.strictObject({
  title: z.string().max(MAX_HINT_TITLE),
  names: z.array(z.string().max(MAX_HINT_NAME)).max(MAX_HINT_NAMES),
});

export type TranscribeHint = z.infer<typeof transcribeHintSchema>;

export const EMPTY_HINT: TranscribeHint = { title: "", names: [] };

const UNSAFE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu;

export function cleanHintText(value: string): string {
  return value.normalize("NFC").replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeHint(hint: { title?: string; names?: readonly string[] }): TranscribeHint {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of hint.names ?? []) {
    const name = cleanHintText(raw);
    const key = name.toLowerCase();
    if (!name || name.length > MAX_HINT_NAME || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === MAX_HINT_NAMES) break;
  }
  return { title: cleanHintText(hint.title ?? "").slice(0, MAX_HINT_TITLE).trim(), names };
}

/** "Mara, the keeper" → "Mara"; a long description is not a name and is skipped. */
function leadingName(value: string): string {
  const head = value.split(/[,;:()[\]—–]| - /)[0]?.trim() ?? "";
  return head.split(/\s+/).length <= 4 ? head : "";
}

export function transcribeHintFor(session: Pick<StorySession, "title" | "plan" | "context">): TranscribeHint {
  const facts = (session.context?.facts ?? []).filter(
    (fact) => fact.category === "characters" || fact.category === "locations",
  );
  return sanitizeHint({
    title: session.title,
    names: [
      ...(session.plan?.characters ?? []).map((character) => character.name),
      ...(session.plan?.locations ?? []).map((location) => location.name),
      ...facts.map((fact) => leadingName(fact.value)),
    ],
  });
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 of UTF-8 JSON (header values must be ASCII); trailing names are dropped until it fits the header budget. */
export function encodeTranscribeHint(hint: TranscribeHint): string {
  const { title, names } = sanitizeHint(hint);
  for (let count = names.length; count >= 0; count -= 1) {
    if (!title && count === 0) return "";
    const encoded = toBase64(JSON.stringify({ title, names: names.slice(0, count) }));
    if (encoded.length <= MAX_HINT_HEADER) return encoded;
  }
  return "";
}

export type HintCheck = { ok: true; hint: TranscribeHint } | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeTranscribeHint(header: string | null): HintCheck {
  const value = header?.trim() ?? "";
  if (!value) return { ok: true, hint: EMPTY_HINT };
  const invalid: HintCheck = { ok: false, error: INVALID_HINT_MESSAGE };
  if (value.length > MAX_HINT_HEADER || value.length % 4 !== 0 || !BASE64.test(value)) return invalid;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const parsed = transcribeHintSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return parsed.success ? { ok: true, hint: sanitizeHint(parsed.data) } : invalid;
  } catch {
    return invalid;
  }
}
