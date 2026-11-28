import assert from "node:assert/strict";
import { test } from "node:test";
import { audioMatches } from "../src/lib/audio.ts";
import { modelTestResponseSchema } from "../src/lib/models.ts";
import {
  failureReason,
  NOT_SET_UP,
  STORY_TEST_MAX_OUTPUT_TOKENS,
  TEST_MESSAGES,
  testStoryModel,
  testVoiceModel,
  VOICE_TEST_TIMEOUT_MS,
  type VoiceTranscriberFactory,
} from "../src/lib/server/model-catalog.ts";
import { TranscriptionError } from "../src/lib/server/transcription/provider.ts";
import { transcriptMatchesSample, VOICE_SAMPLE_WORDS, voiceSample } from "../src/lib/server/voice-sample.ts";

const GEMINI_KEY = "gm-test-not-real";

type Hooks = { mock: { method: (object: object, name: string, impl: (...args: unknown[]) => void) => void } };

function quiet(t: Hooks) {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
}

type Call = { apiKey: string; model: string; timeoutMs?: number; audio: Uint8Array; format: string; hint: unknown };

function fakeTranscriber(answer: () => Promise<string> | string): { calls: Call[]; create: VoiceTranscriberFactory } {
  const calls: Call[] = [];
  const create: VoiceTranscriberFactory = (config) => ({
    async transcribe({ audio, format, hint }) {
      calls.push({ ...config, audio, format, hint });
      const text = await answer();
      return {
        text,
        usage: { step: "transcribe", model: config.model, inputTokens: 120, outputTokens: 12, totalTokens: 132 },
      };
    },
  });
  return { calls, create };
}

function failingTranscriber(error: unknown): VoiceTranscriberFactory {
  return () => ({
    async transcribe() {
      throw error;
    },
  });
}

// --- The bundled clip ---

test("the bundled speech clip is a real 16 kHz mono WAV and each copy is independent", () => {
  const first = voiceSample();
  assert.equal(first.byteLength, 86_200);
  assert.ok(audioMatches("wav", first));
  const view = new DataView(first.buffer);
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16_000, "16 kHz");
  first[0] = 0;
  assert.ok(audioMatches("wav", voiceSample()));
});

test("a transcript passes with at least three of the clip's words, in any case or punctuation", () => {
  assert.deepEqual([...VOICE_SAMPLE_WORDS], ["testing", "voice", "text", "story", "planner"]);
  assert.ok(transcriptMatchesSample("Testing voice to text for the story planner."));
  assert.ok(transcriptMatchesSample("TESTING voice-to-text"));
  assert.ok(transcriptMatchesSample("the story planner's voice"));
  assert.ok(!transcriptMatchesSample("Testing voice."));
  assert.ok(!transcriptMatchesSample("OK"));
  assert.ok(!transcriptMatchesSample(""));
  assert.ok(!transcriptMatchesSample("textual storytelling plannerish voices"));
});

// --- Voice check ---

test("the voice check passes when the model writes the clip's words back", async (t) => {
  quiet(t);
  const fake = fakeTranscriber(() => "Testing voice to text for the story planner.");
  const result = await testVoiceModel(GEMINI_KEY, "gemini-3.5-transcribe", { createTranscriber: fake.create });
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
  assert.match(result.message, /^Works — \d+\.\d s$/);
  assert.deepEqual(result.usage, { model: "gemini-3.5-transcribe", inputTokens: 120, outputTokens: 12, totalTokens: 132 });
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.deepEqual([call.apiKey, call.model, call.timeoutMs, call.format], [GEMINI_KEY, "gemini-3.5-transcribe", VOICE_TEST_TIMEOUT_MS, "wav"]);
  assert.ok(audioMatches("wav", call.audio));
  assert.deepEqual(call.hint, { title: "", names: [] }, "no hint, so the words can't come from the prompt");
  assert.ok(VOICE_TEST_TIMEOUT_MS <= 25_000);
});

test("the voice check fails when the model answers but the words are wrong or missing", async (t) => {
  quiet(t);
  for (const answer of ["OK", "", "Testing."]) {
    const result = await testVoiceModel(GEMINI_KEY, "gemini-2.5-flash", { createTranscriber: fakeTranscriber(() => answer).create });
    assert.deepEqual([result.ok, result.reason, result.message], [false, "unsupported", TEST_MESSAGES.misheard], answer);
    assert.equal(result.usage, undefined);
  }
});

test("voice provider failures map to plain reasons", async (t) => {
  quiet(t);
  const cases: [unknown, string][] = [
    [new TranscriptionError("upstream", { status: 503, code: "UNAVAILABLE" }), "busy"],
    [new TranscriptionError("model", { status: 404 }), "no_access"],
    [new TranscriptionError("auth", { status: 400, reason: "API_KEY_INVALID" }), "no_access"],
    [new TranscriptionError("unavailable", { status: 400, code: "FAILED_PRECONDITION" }), "no_access"],
    [new TranscriptionError("rate_limited", { status: 429 }), "rate_limit"],
    [new TranscriptionError("timeout"), "timeout"],
    [new TranscriptionError("bad_audio", { status: 400 }), "unsupported"],
    [new TranscriptionError("invalid_response", { reason: "unparsable_output" }), "unsupported"],
    [new TranscriptionError("upstream", { status: 500 }), "unreachable"],
    [new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
    [new TypeError("fetch failed"), "unreachable"],
  ];
  for (const [error, reason] of cases) {
    const result = await testVoiceModel(GEMINI_KEY, "gemini-2.5-flash", { createTranscriber: failingTranscriber(error) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason, String(error));
    assert.ok(result.message.length > 0);
  }
});

test("without a Gemini key the voice check says how to set it up and never calls the provider", async () => {
  const fake = fakeTranscriber(() => "unused");
  const result = await testVoiceModel(null, "gemini-2.5-flash", { createTranscriber: fake.create });
  assert.deepEqual(result, { ok: false, ms: 0, reason: "not_set_up", message: NOT_SET_UP.voice });
  assert.equal(fake.calls.length, 0);
});

test("the voice check never logs or returns the key or the transcript", async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => logged.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => logged.push(args));
  const transcript = "Testing voice to text for the story planner.";
  const pass = await testVoiceModel(GEMINI_KEY, "gemini-3.5-transcribe", { createTranscriber: fakeTranscriber(() => transcript).create });
  const fail = await testVoiceModel(GEMINI_KEY, "gemini-3.5-transcribe", {
    createTranscriber: failingTranscriber(new TranscriptionError("auth", { status: 403 })),
  });
  const output = JSON.stringify([pass, fail, logged]);
  assert.ok(!output.includes(GEMINI_KEY));
  assert.ok(!output.includes(transcript));
  modelTestResponseSchema.parse(pass);
  modelTestResponseSchema.parse(fail);
});

// --- Story check ---

type ParseCall = { body: Record<string, unknown>; options: Record<string, unknown> };

function storyClient(reply: () => unknown) {
  const calls: ParseCall[] = [];
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>, options: Record<string, unknown>) => {
        calls.push({ body, options });
        return reply();
      },
    },
  };
  return { calls, client: client as unknown as Parameters<typeof testStoryModel>[0] };
}

const completed = (parsed: unknown, status = "completed") => ({
  status,
  model: "gpt-5-mini-2026-01-01",
  output_parsed: parsed,
  usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
});

test("the story check passes only on a completed answer with a parsed ok", async (t) => {
  quiet(t);
  const { calls, client } = storyClient(() => completed({ ok: true }));
  const result = await testStoryModel(client, "gpt-5-mini");
  assert.equal(result.ok, true);
  assert.deepEqual(result.usage, { model: "gpt-5-mini-2026-01-01", inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "gpt-5-mini");
  assert.equal(calls[0].body.max_output_tokens, STORY_TEST_MAX_OUTPUT_TOKENS);

  const falseIsStillAnAnswer = await testStoryModel(storyClient(() => completed({ ok: false })).client, "gpt-5-mini");
  assert.equal(falseIsStillAnAnswer.ok, true);
});

test("the story check fails on an unfinished, empty or malformed answer", async (t) => {
  quiet(t);
  for (const reply of [completed({ ok: true }, "incomplete"), completed(null), completed({ ok: "yes" }), completed({ ok: true }, "failed")]) {
    const result = await testStoryModel(storyClient(() => reply).client, "o3");
    assert.deepEqual([result.ok, result.reason, result.message], [false, "unsupported", TEST_MESSAGES.unsupported]);
  }
  const unparsable = await testStoryModel(
    storyClient(() => {
      throw new SyntaxError("Unexpected end of JSON input");
    }).client,
    "o3",
  );
  assert.equal(unparsable.reason, "unsupported");
});

test("failure reasons cover access, limits, busy providers and timeouts", () => {
  assert.equal(failureReason(401), "no_access");
  assert.equal(failureReason(403), "no_access");
  assert.equal(failureReason(404), "no_access");
  assert.equal(failureReason(400), "unsupported");
  assert.equal(failureReason(429), "rate_limit");
  assert.equal(failureReason(503), "busy");
  assert.equal(failureReason(504), "timeout");
  assert.equal(failureReason(undefined, true), "timeout");
  assert.equal(failureReason(500), "unreachable");
  assert.equal(failureReason(undefined), "unreachable");
});
