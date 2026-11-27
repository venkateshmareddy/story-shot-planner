import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { STORY_MODEL } from "@/lib/models";
import { SOURCE_RULES } from "@/lib/server/prompts";
import { chunkText, type DigestResponse, MAX_DIGEST_CHARACTERS, MAX_SOURCE_CHARACTERS } from "@/lib/source-text";
import { toUsageRecord, type UsageRecord } from "@/lib/usage";

export const DIGEST_BODY_BYTES = 1_500_000;
export const DIGEST_NAME_MAX = 200;
export const DIGEST_MAX_OUTPUT_TOKENS = 1_500;
/** Below the route's maxDuration so a slow part fails cleanly instead of being killed by the platform. */
export const DIGEST_TIMEOUT_MS = 85_000;
export const DIGEST_FAILED_MESSAGE = "The long story couldn't be condensed. Try again.";

export const digestRequest = z.object({
  name: z
    .string()
    .transform((name) => name.replace(/\p{Cc}+/gu, " ").trim())
    .pipe(z.string().min(1).max(DIGEST_NAME_MAX)),
  text: z.string().min(1).max(MAX_SOURCE_CHARACTERS),
});
export type DigestRequest = z.infer<typeof digestRequest>;

export const chunkDigestOutput = z.object({
  events: z.array(z.string()),
  characters: z.array(z.string()),
  places: z.array(z.string()),
  dialogue: z.array(z.string()),
  tone: z.string(),
  visuals: z.array(z.string()),
});
export type ChunkDigest = z.infer<typeof chunkDigestOutput>;

export const DIGEST_INSTRUCTIONS = [
  SOURCE_RULES,
  "You condense one part of a long story that a filmmaker imported, so a short film can be planned from it later. The JSON input holds the file name (source), which part this is (part of parts) and that part's text (text). Other parts are condensed separately: cover only this part, from its first line to its last.",
  "Preserve every character name exactly as written, the order of events and specific details (objects, numbers, times, colours, injuries, weather). Never invent, guess, merge or add anything that is not in the text. When the text has nothing for a field, return an empty list or an empty string.",
  'Fields: events is what happens, in order, one short sentence each (at most 12). characters is each person who appears, as "Name: key details" such as role, look, relationships and what they want (at most 8). places is each location, as "Name: what it looks like" (at most 6). dialogue is the most important lines copied word for word, never paraphrased, as "Speaker: line" (use "Unknown" when the speaker is unclear; at most 6). tone is one or two sentences on the mood and feel. visuals is notable props and visual details (at most 6).',
].join("\n");

export type DigestModelCall = {
  instructions: string;
  input: string;
  maxOutputTokens: number;
  signal: AbortSignal;
};

/** Output is treated as unknown and re-validated by createDigest. */
export type DigestCallModel = (call: DigestModelCall) => Promise<{ output: unknown; usage: UsageRecord }>;

/** A call that returned (and cost tokens) but produced no usable output. */
export class IncompleteDigestError extends Error {
  constructor(readonly usage: UsageRecord) {
    super("Incomplete digest part");
    this.name = "IncompleteDigestError";
  }
}

/** One or more parts failed; no partial digest is returned. */
export class DigestError extends Error {
  constructor(
    cause: unknown,
    readonly usage: UsageRecord[],
    readonly chunks: number,
  ) {
    super("The story digest failed", { cause });
    this.name = "DigestError";
  }
}

export function openAIDigestModel(client: Pick<OpenAI, "responses">): DigestCallModel {
  return async ({ instructions, input, maxOutputTokens, signal }) => {
    const response = await client.responses.parse(
      {
        model: STORY_MODEL,
        store: false,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        text: { format: zodTextFormat(chunkDigestOutput, "story_digest_part") },
      },
      { signal },
    );
    const model = response.model || STORY_MODEL;
    const usage = toUsageRecord("digest", model, response.usage);
    console.info("Model usage", { step: "digest", model, usage });
    if (response.status !== "completed" || !response.output_parsed) throw new IncompleteDigestError(usage);
    return { output: response.output_parsed, usage };
  };
}

export type DigestOptions = { name?: string; signal?: AbortSignal; timeoutMs?: number };

/** Condense every chunk in parallel and assemble them in order. Any failed chunk fails the whole digest. */
export async function createDigest(
  text: string,
  callModel: DigestCallModel,
  options: DigestOptions = {},
): Promise<DigestResponse> {
  const chunks = chunkText(text);
  if (!chunks.length) throw new DigestError(new Error("Nothing to condense"), [], 0);

  const stop = new AbortController();
  const signals = [stop.signal, AbortSignal.timeout(options.timeoutMs ?? DIGEST_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const usage: (UsageRecord | undefined)[] = new Array(chunks.length);
  const recorded = () => usage.filter((record): record is UsageRecord => record !== undefined);

  try {
    const parts = await Promise.all(
      chunks.map(async (chunk, index) => {
        let result: Awaited<ReturnType<DigestCallModel>>;
        try {
          result = await callModel({
            instructions: DIGEST_INSTRUCTIONS,
            input: JSON.stringify({ source: options.name ?? "", part: index + 1, parts: chunks.length, text: chunk }),
            maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS,
            signal,
          });
        } catch (error) {
          if (error instanceof IncompleteDigestError) usage[index] = error.usage;
          throw error;
        }
        usage[index] = result.usage;
        const parsed = chunkDigestOutput.safeParse(result.output);
        if (!parsed.success) throw new Error(`Part ${index + 1} returned an invalid digest`);
        const part = cleanPart(parsed.data);
        if (isEmpty(part)) throw new Error(`Part ${index + 1} returned an empty digest`);
        return part;
      }),
    );
    return { digest: assembleDigest(parts), chunks: chunks.length, usage: recorded() };
  } catch (error) {
    stop.abort();
    throw new DigestError(error, recorded(), chunks.length);
  }
}

function cleanLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-•*]\s+/, "")
    .trim();
}

function cleanPart(part: ChunkDigest): ChunkDigest {
  const list = (items: string[]) => items.map(cleanLine).filter(Boolean);
  return {
    events: list(part.events),
    characters: list(part.characters),
    places: list(part.places),
    dialogue: list(part.dialogue),
    tone: cleanLine(part.tone),
    visuals: list(part.visuals),
  };
}

function isEmpty(part: ChunkDigest): boolean {
  return !part.tone && [part.events, part.characters, part.places, part.dialogue, part.visuals].every((items) => !items.length);
}

type Detail = { items: number; chars: number };

// Applied to every part alike, most detailed first; events keep twice as many items as the other lists.
const DETAIL_LEVELS: readonly Detail[] = [
  { items: Number.POSITIVE_INFINITY, chars: Number.POSITIVE_INFINITY },
  { items: 10, chars: 320 },
  { items: 8, chars: 240 },
  { items: 6, chars: 200 },
  { items: 5, chars: 160 },
  { items: 4, chars: 130 },
  { items: 3, chars: 110 },
  { items: 2, chars: 90 },
  { items: 1, chars: 70 },
];

const PART_SEPARATOR = "\n\n";

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function renderPart(part: ChunkDigest, index: number, total: number, detail: Detail): string {
  const lines = [`Part ${index + 1} of ${total}`];
  const list = (label: string, items: string[], limit: number) => {
    const shown = items.slice(0, limit);
    if (shown.length) lines.push(`${label}:`, ...shown.map((item) => `- ${clip(item, detail.chars)}`));
  };
  list("What happens", part.events, detail.items * 2);
  list("Characters", part.characters, detail.items);
  list("Places", part.places, detail.items);
  list("Key lines", part.dialogue, detail.items);
  if (part.tone) lines.push(`Tone: ${clip(part.tone, detail.chars * 2)}`);
  list("Props and visual details", part.visuals, detail.items);
  return lines.join("\n");
}

/** Plain-text digest, "Part i of N" in order, never longer than `max`. Shrinks every part alike; never drops one. */
export function assembleDigest(parts: ChunkDigest[], max = MAX_DIGEST_CHARACTERS): string {
  for (const detail of DETAIL_LEVELS) {
    const digest = parts.map((part, index) => renderPart(part, index, parts.length, detail)).join(PART_SEPARATOR);
    if (digest.length <= max) return digest;
  }
  const smallest = DETAIL_LEVELS[DETAIL_LEVELS.length - 1];
  const budget = Math.floor((max - PART_SEPARATOR.length * (parts.length - 1)) / parts.length);
  return parts
    .map((part, index) => clip(renderPart(part, index, parts.length, smallest), budget))
    .join(PART_SEPARATOR);
}
