import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { POST } from "../src/app/api/story/digest/route.ts";
import { STORY_MODEL } from "../src/lib/models.ts";
import {
  assembleDigest,
  type ChunkDigest,
  chunkDigestOutput,
  createDigest,
  DIGEST_INSTRUCTIONS,
  DIGEST_MAX_OUTPUT_TOKENS,
  DigestError,
  type DigestModelCall,
  IncompleteDigestError,
  openAIDigestModel,
} from "../src/lib/server/digest.ts";
import { SOURCE_RULES } from "../src/lib/server/prompts.ts";
import { chunkText, MAX_DIGEST_CHARACTERS, MAX_SOURCE_CHARACTERS } from "../src/lib/source-text.ts";
import type { UsageRecord } from "../src/lib/usage.ts";

function longStory(length: number): string {
  const paragraphs: string[] = [];
  let total = 0;
  for (let p = 0; total < length; p++) {
    const paragraph = Array.from({ length: 3 + (p % 7) }, (_, s) => `Mara${p} opens drawer ${s} and finds a key.`).join(" ");
    paragraphs.push(paragraph);
    total += paragraph.length + 2;
  }
  return paragraphs.join("\n\n").slice(0, length).trim();
}

const usageFor = (part: number): UsageRecord => ({
  step: "digest",
  model: STORY_MODEL,
  inputTokens: 1_000 + part,
  outputTokens: 300,
  totalTokens: 1_300 + part,
});

function partOutput(part: number, size = 1): ChunkDigest {
  const many = (prefix: string) => Array.from({ length: 6 * size }, (_, i) => `${prefix} ${part}.${i} ${"detail ".repeat(10 * size)}`);
  return {
    events: [`Event ${part} begins.`, ...many("Event")],
    characters: [`Mara: courier in part ${part}`, ...many("Character")],
    places: many("Place"),
    dialogue: [`Mara: "Part ${part} line, word for word."`, ...many("Line")],
    tone: `Tense in part ${part}.`,
    visuals: many("Prop"),
  };
}

function inputOf(call: DigestModelCall) {
  return JSON.parse(call.input) as { source: string; part: number; parts: number; text: string };
}

test("chunk schema is flat and instructions keep names, order and lines without inventing", () => {
  assert.ok(chunkDigestOutput.safeParse(partOutput(1)).success);
  assert.ok(!chunkDigestOutput.safeParse({ ...partOutput(1), tone: undefined }).success);
  assert.ok(!chunkDigestOutput.safeParse({ ...partOutput(1), dialogue: [{ speaker: "Mara", line: "Hi" }] }).success);
  assert.ok(DIGEST_INSTRUCTIONS.startsWith(SOURCE_RULES));
  assert.match(DIGEST_INSTRUCTIONS, /Never invent/);
  assert.match(DIGEST_INSTRUCTIONS, /word for word/);
  assert.match(DIGEST_INSTRUCTIONS, /order of events/);
});

test("createDigest makes one parallel call per chunk and assembles the parts in order", async () => {
  const text = longStory(60_000);
  const expected = chunkText(text);
  assert.ok(expected.length > 2);
  const calls: DigestModelCall[] = [];
  let active = 0;
  let maxActive = 0;

  const result = await createDigest(
    text,
    async (call) => {
      calls.push(call);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const { part, parts } = inputOf(call);
      await delay((parts - part + 1) * 5);
      active -= 1;
      return { output: partOutput(part), usage: usageFor(part) };
    },
    { name: "novel.pdf" },
  );

  assert.equal(calls.length, expected.length);
  assert.equal(maxActive, expected.length);
  assert.equal(result.chunks, expected.length);
  for (const call of calls) {
    const input = inputOf(call);
    assert.equal(call.instructions, DIGEST_INSTRUCTIONS);
    assert.equal(call.maxOutputTokens, DIGEST_MAX_OUTPUT_TOKENS);
    assert.equal(input.source, "novel.pdf");
    assert.equal(input.parts, expected.length);
    assert.equal(input.text, expected[input.part - 1]);
  }

  assert.deepEqual(
    result.usage,
    expected.map((_, index) => usageFor(index + 1)),
  );
  assert.ok(result.usage.every((record) => record.step === "digest"));

  const headers = expected.map((_, index) => result.digest.indexOf(`Part ${index + 1} of ${expected.length}\n`));
  assert.ok(headers.every((position, index) => position >= 0 && (index === 0 || position > headers[index - 1])));
  assert.ok(result.digest.startsWith(`Part 1 of ${expected.length}\nWhat happens:\n- Event 1 begins.`));
  assert.match(result.digest, /Key lines:\n- Mara: "Part 2 line, word for word\."/);
  assert.match(result.digest, /Tone: Tense in part 3\./);
});

test("the digest stays under the cap by shrinking every part, never dropping one", async () => {
  const text = longStory(MAX_SOURCE_CHARACTERS);
  const chunks = chunkText(text).length;
  assert.equal(chunks, 8);
  const result = await createDigest(text, async (call) => {
    const { part } = inputOf(call);
    return { output: partOutput(part, 4), usage: usageFor(part) };
  });
  assert.ok(result.digest.length <= MAX_DIGEST_CHARACTERS, `length ${result.digest.length}`);
  for (let part = 1; part <= chunks; part++) {
    assert.ok(result.digest.includes(`Part ${part} of ${chunks}\nWhat happens:\n- Event ${part} begins.`), `part ${part}`);
    assert.ok(result.digest.includes(`Mara: "Part ${part} line, word for word."`), `line ${part}`);
  }
  assert.equal(result.usage.length, chunks);
});

test("assembleDigest keeps small digests whole and hard-caps tiny limits without dropping parts", () => {
  const parts = [partOutput(1), partOutput(2)];
  const full = assembleDigest(parts);
  for (const part of parts) {
    for (const item of [...part.events, ...part.characters, ...part.places, ...part.dialogue, ...part.visuals]) {
      assert.ok(full.includes(`- ${item.trim()}`), item);
    }
  }

  const many = Array.from({ length: 8 }, (_, index) => partOutput(index + 1, 4));
  const tiny = assembleDigest(many, 400);
  assert.ok(tiny.length <= 400, `length ${tiny.length}`);
  for (let part = 1; part <= 8; part++) assert.ok(tiny.includes(`Part ${part} of 8`));
});

test("any failed chunk fails the whole digest, aborts the rest and keeps spent usage", async () => {
  const text = longStory(60_000);
  const total = chunkText(text).length;
  let aborted = 0;
  await assert.rejects(
    createDigest(text, async ({ input, signal }) => {
      const { part } = JSON.parse(input) as { part: number };
      if (part === 1) return { output: partOutput(1), usage: usageFor(1) };
      if (part === 2) {
        await delay(5);
        throw new Error("model failed");
      }
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 2_000);
        signal.addEventListener("abort", () => {
          clearTimeout(fallback);
          aborted += 1;
          resolve();
        });
      });
      throw signal.reason;
    }),
    (error: unknown) => {
      assert.ok(error instanceof DigestError);
      assert.equal(error.chunks, total);
      assert.deepEqual(error.usage, [usageFor(1)]);
      assert.equal((error.cause as Error).message, "model failed");
      return true;
    },
  );
  assert.equal(aborted, total - 2);
});

test("invalid, empty or incomplete chunk output fails the digest", async () => {
  const text = longStory(30_000);
  const outputs: unknown[] = [
    { ...partOutput(1), events: "not a list" },
    { events: [], characters: [" "], places: [], dialogue: [], tone: "", visuals: [] },
  ];
  for (const output of outputs) {
    await assert.rejects(
      createDigest(text, async ({ input }) => {
        const { part } = JSON.parse(input) as { part: number };
        return { output: part === 2 ? output : partOutput(part), usage: usageFor(part) };
      }),
      DigestError,
    );
  }
  await assert.rejects(
    createDigest(text, async ({ input }) => {
      const { part } = JSON.parse(input) as { part: number };
      if (part === 2) throw new IncompleteDigestError(usageFor(2));
      return { output: partOutput(part), usage: usageFor(part) };
    }),
    (error: unknown) => error instanceof DigestError && error.usage.some((record) => record.inputTokens === 1_002),
  );
});

test("a chunk that runs past the deadline fails the digest", async () => {
  await assert.rejects(
    createDigest(
      longStory(30_000),
      ({ signal }) =>
        new Promise((_, reject) => {
          const fallback = setTimeout(() => reject(new Error("deadline not applied")), 2_000);
          signal.addEventListener("abort", () => {
            clearTimeout(fallback);
            reject(signal.reason);
          });
        }),
      { timeoutMs: 20 },
    ),
    (error: unknown) => error instanceof DigestError && (error.cause as Error).name === "TimeoutError",
  );
});

test("the OpenAI adapter sends a bounded, unstored structured call and records digest usage", async () => {
  const requests: Record<string, unknown>[] = [];
  const reply = (status: string) => ({
    status,
    model: "gpt-returned",
    output_parsed: status === "completed" ? partOutput(1) : null,
    usage: { input_tokens: 900, output_tokens: 200, total_tokens: 1_100 },
  });
  let status = "completed";
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>) => {
        requests.push(body);
        return reply(status);
      },
    },
  } as unknown as Parameters<typeof openAIDigestModel>[0];
  const call = { instructions: DIGEST_INSTRUCTIONS, input: "{}", maxOutputTokens: 1_500, signal: new AbortController().signal };

  const result = await openAIDigestModel(client)(call);
  assert.deepEqual(result.usage, { step: "digest", model: "gpt-returned", inputTokens: 900, outputTokens: 200, totalTokens: 1_100 });
  assert.equal(requests[0].model, STORY_MODEL);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].max_output_tokens, 1_500);
  assert.equal((requests[0].text as { format: { type: string } }).format.type, "json_schema");

  status = "incomplete";
  await assert.rejects(openAIDigestModel(client)(call), IncompleteDigestError);
});

function digestRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/story/digest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("digest route validates input before any model call", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal((await POST(digestRequest("{not json"))).status, 400);
    assert.equal((await POST(digestRequest({ text: "A story." }))).status, 400);
    assert.equal((await POST(digestRequest({ name: " ", text: "A story." }))).status, 400);
    assert.equal((await POST(digestRequest({ name: "x".repeat(201), text: "A story." }))).status, 400);
    assert.equal((await POST(digestRequest({ name: "a.txt", text: "" }))).status, 400);
    assert.equal((await POST(digestRequest({ name: "a.txt", text: " \u0001 " }))).status, 400);
    assert.equal((await POST(digestRequest({ name: "a.txt", text: `x ${"�".repeat(100)}` }))).status, 400);

    const tooLong = await POST(digestRequest({ name: "a.txt", text: "a".repeat(MAX_SOURCE_CHARACTERS + 1) }));
    assert.equal(tooLong.status, 413);
    assert.match((await tooLong.json()).error, /too long/);
    assert.equal((await POST(digestRequest({ name: "a.txt", text: "A story." }, { "content-length": "2000000" }))).status, 413);

    const noKey = await POST(digestRequest({ name: "novel.pdf", text: longStory(30_000) }));
    assert.equal(noKey.status, 503);
    assert.match((await noKey.json()).error, /OPENAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
