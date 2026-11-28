import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { POST } from "../src/app/api/story/transcribe/route.ts";
import { encodeWav } from "../src/lib/audio-wav.ts";
import { SOURCE_RULES } from "../src/lib/server/prompts.ts";
import {
  createGeminiTranscriber,
  GEMINI_API_BASE,
  GEMINI_TRANSCRIBE_MAX_OUTPUT_TOKENS,
  geminiConfigFromEnv,
  geminiTranscribeBody,
  geminiUsage,
  unwrapTranscript,
} from "../src/lib/server/transcription/gemini.ts";
import {
  TRANSCRIBE_INSTRUCTIONS,
  TranscriptionError,
  transcriptionHintText,
  transcriptionPrompt,
} from "../src/lib/server/transcription/provider.ts";
import { MAX_STORY_CHARACTERS } from "../src/lib/story-input.ts";
import {
  DEFAULT_GEMINI_TRANSCRIBE_MODEL,
  EMPTY_HINT,
  encodeTranscribeHint,
  INVALID_HINT_MESSAGE,
  MAX_HINT_NAME,
  MAX_HINT_NAMES,
  MAX_HINT_TITLE,
} from "../src/lib/transcription.ts";

const KEY = "test-gemini-key-123";
const WAV = encodeWav(new Float32Array([0, 0.5, -0.5, 0.25]));
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
const USAGE_METADATA = { promptTokenCount: 812, candidatesTokenCount: 40, totalTokenCount: 852 };

type Sent = { url: string; init: RequestInit; body: Record<string, any> };

const originalFetch = globalThis.fetch;
const savedEnv = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_TRANSCRIBE_MODEL };
let logs: unknown[] = [];

beforeEach((t) => {
  process.env.GEMINI_API_KEY = KEY;
  delete process.env.GEMINI_TRANSCRIBE_MODEL;
  logs = [];
  t.mock.method(console, "info", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedEnv.key === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnv.key;
  if (savedEnv.model === undefined) delete process.env.GEMINI_TRANSCRIBE_MODEL;
  else process.env.GEMINI_TRANSCRIBE_MODEL = savedEnv.model;
});

function geminiReply(text: string, extra: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: USAGE_METADATA,
    modelVersion: "gemini-3.5-transcribe",
    ...extra,
  };
}

function mockGemini(reply: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
}

function upload(body: Uint8Array, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/story/transcribe", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-audio-extension": "wav", "x-audio-type": "audio/wav", ...headers },
    body,
  });
}

const hintHeader = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64");

test("the default voice model is the dedicated transcribe model", () => {
  assert.equal(DEFAULT_GEMINI_TRANSCRIBE_MODEL, "gemini-3.5-transcribe");
  assert.equal(geminiConfigFromEnv({ GEMINI_API_KEY: KEY })?.model, "gemini-3.5-transcribe");
});

test("the instruction is SAFETY then the TRANSCRIBE brain: clean verbatim, never translate, film terms, plain text", () => {
  assert.ok(TRANSCRIBE_INSTRUCTIONS.startsWith(SOURCE_RULES));
  assert.match(TRANSCRIBE_INSTRUCTIONS, /clean verbatim/);
  assert.match(TRANSCRIBE_INSTRUCTIONS, /never translate/);
  assert.match(TRANSCRIBE_INSTRUCTIONS, /Never add, summarise/);
  assert.match(TRANSCRIBE_INSTRUCTIONS, /Keep every name exactly/);
  for (const term of ["close-up", "wide shot", "medium shot", "voice-over", "Foley", "dolly", "pan", "tilt", "fade"]) {
    assert.ok(TRANSCRIBE_INSTRUCTIONS.includes(term), term);
  }
  assert.match(TRANSCRIBE_INSTRUCTIONS, /as plain text/);
  assert.match(TRANSCRIBE_INSTRUCTIONS, /return an empty reply/);
  assert.ok(!/JSON with one field/.test(TRANSCRIBE_INSTRUCTIONS));
});

test("the route sends Gemini one request: key in a header only, instructions and hint as the first user part, then the audio", async () => {
  const sent = mockGemini(geminiReply("  Mara climbs the lighthouse. Wide shot.  "));
  const hint = encodeTranscribeHint({ title: "The Lighthouse Keeper", names: ["Mara", "Ravi", "Pier"] });
  const response = await POST(upload(WAV, { "x-transcribe-hint": hint }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "Mara climbs the lighthouse. Wide shot.",
    usage: { step: "transcribe", model: "gemini-3.5-transcribe", inputTokens: 812, outputTokens: 40, totalTokens: 852 },
  });

  assert.equal(sent.length, 1);
  const [{ url, init, body }] = sent;
  assert.equal(url, `${GEMINI_API_BASE}/models/${DEFAULT_GEMINI_TRANSCRIBE_MODEL}:generateContent`);
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent");
  assert.ok(!url.includes(KEY) && !url.includes("key="), "the key never goes in the URL");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("x-goog-api-key"), KEY);
  assert.equal(headers.get("content-type"), "application/json");
  assert.ok(init.signal instanceof AbortSignal);

  assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig"]);
  assert.equal(body.system_instruction, undefined);
  assert.equal(body.systemInstruction, undefined);
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].role, "user");
  const [textPart, audioPart, ...rest] = body.contents[0].parts;
  assert.equal(rest.length, 0);
  assert.equal(textPart.text, `${TRANSCRIBE_INSTRUCTIONS}\nProject title: The Lighthouse Keeper\nNames in this project: Mara; Ravi; Pier`);
  assert.ok(textPart.text.startsWith(SOURCE_RULES), "SAFETY stays at the top");
  assert.deepEqual(audioPart, { inline_data: { mime_type: "audio/wav", data: Buffer.from(WAV).toString("base64") } });
  assert.deepEqual(body.generationConfig, { temperature: 0, maxOutputTokens: GEMINI_TRANSCRIBE_MAX_OUTPUT_TOKENS });
  assert.ok(GEMINI_TRANSCRIBE_MAX_OUTPUT_TOKENS > 0);
  const raw = JSON.stringify(body);
  for (const banned of ["system_instruction", "systemInstruction", "responseSchema", "responseMimeType", "thinkingConfig"]) {
    assert.ok(!raw.includes(banned), `${banned} is never sent`);
  }

  const logged = JSON.stringify(logs);
  assert.ok(!logged.includes(KEY), "the key is never logged");
  assert.ok(!logged.includes("Mara climbs"), "the transcript is never logged");
});

test("without a hint the data part says so; MP3 goes as audio/mp3 and GEMINI_TRANSCRIBE_MODEL picks the model", async () => {
  process.env.GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-flash";
  const sent = mockGemini(geminiReply("Hello."));
  const response = await POST(upload(MP3, { "x-audio-extension": "mp3", "x-audio-type": "audio/mpeg" }));
  assert.equal(response.status, 200);
  assert.match(sent[0].url, /\/models\/gemini-3\.5-flash:generateContent$/);
  assert.equal(sent[0].body.contents[0].parts[0].text, transcriptionPrompt(EMPTY_HINT));
  assert.ok(sent[0].body.contents[0].parts[0].text.endsWith(transcriptionHintText(EMPTY_HINT)));
  assert.equal(transcriptionHintText(EMPTY_HINT), "Project title: (none)\nNames in this project: (none)");
  assert.equal(sent[0].body.contents[0].parts[1].inline_data.mime_type, "audio/mp3");
});

test("a missing key or a malformed model id is a plain 503 and Gemini is never called", async () => {
  const sent = mockGemini(geminiReply("x"));
  delete process.env.GEMINI_API_KEY;
  const noKey = await POST(upload(WAV));
  assert.equal(noKey.status, 503);
  assert.deepEqual(await noKey.json(), { error: "Voice-to-text isn’t set up yet." });

  process.env.GEMINI_API_KEY = "   ";
  assert.equal((await POST(upload(WAV))).status, 503);

  process.env.GEMINI_API_KEY = KEY;
  process.env.GEMINI_TRANSCRIBE_MODEL = "../../v1/files?x=";
  const badModel = await POST(upload(WAV));
  assert.equal(badModel.status, 503);
  assert.equal(sent.length, 0);
  assert.equal(geminiConfigFromEnv({ GEMINI_API_KEY: KEY })?.model, DEFAULT_GEMINI_TRANSCRIBE_MODEL);
  assert.equal(geminiConfigFromEnv({}), null);
});

test("an empty transcript is 422 'No speech', a too-long one is refused, and a malformed response is 502", async () => {
  mockGemini(geminiReply("   "));
  const empty = await POST(upload(WAV));
  assert.equal(empty.status, 422);
  assert.equal((await empty.json()).error, "No speech was found in the voice note.");

  mockGemini(geminiReply("a".repeat(MAX_STORY_CHARACTERS + 1)));
  const long = await POST(upload(WAV));
  assert.equal(long.status, 422);
  assert.equal((await long.json()).error, "Use a shorter voice note.");

  mockGemini({ candidates: [{ finishReason: "STOP" }], usageMetadata: USAGE_METADATA });
  assert.equal((await POST(upload(WAV))).status, 422, "a reply with no parts is no speech");

  for (const reply of [{ candidates: [] }, { candidates: "nope" }, {}]) {
    mockGemini(reply);
    const response = await POST(upload(WAV));
    assert.equal(response.status, 502, JSON.stringify(reply).slice(0, 60));
    assert.equal((await response.json()).error, "Voice-to-text couldn’t finish. Try again.");
  }
});

test("Gemini errors map to plain messages without provider details", async () => {
  const cases: [number, unknown, number, RegExp][] = [
    [403, { error: { code: 403, status: "PERMISSION_DENIED", message: "secret detail" } }, 503, /Check the Gemini API key/],
    [401, { error: { code: 401, status: "UNAUTHENTICATED" } }, 503, /Check the Gemini API key/],
    [
      400,
      { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } },
      503,
      /Check the Gemini API key/,
    ],
    [429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, 429, /^Voice-to-text is busy — try again in a minute\.$/],
    [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Unsupported MIME type" } }, 422, /couldn’t be read/],
    [400, { error: { code: 400, status: "FAILED_PRECONDITION" } }, 503, /account or region/],
    [404, { error: { code: 404, status: "NOT_FOUND" } }, 503, /Gemini model name/],
    [500, { error: { code: 500, status: "INTERNAL" } }, 502, /couldn’t finish/],
    [503, { error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded due to high demand. secret detail" } }, 503, /^Gemini is busy right now — try again in a minute\.$/],
    [503, "<html>overloaded</html>", 503, /^Gemini is busy right now/],
    ...["Developer instruction", "JSON mode", "Thinking", "Audio input"].map(
      (feature): [number, unknown, number, RegExp] => [
        400,
        { error: { code: 400, status: "INVALID_ARGUMENT", message: `${feature} is not enabled for this model. secret detail` } },
        503,
        /^This voice model can’t be used for voice-to-text\. Choose another in Settings → Models\.$/,
      ],
    ),
  ];
  for (const [status, reply, expected, message] of cases) {
    mockGemini(reply, status);
    const response = await POST(upload(WAV));
    const { error } = await response.json();
    assert.equal(response.status, expected, `${status} ${JSON.stringify(reply).slice(0, 80)}`);
    assert.match(error, message);
    assert.ok(!error.includes("secret detail") && !error.includes(KEY));
  }
  assert.ok(!JSON.stringify(logs).includes("secret detail"), "provider messages are never logged");
});

test("blocked or truncated output is a plain 422", async () => {
  const cases: [unknown, RegExp][] = [
    [{ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: USAGE_METADATA }, /couldn’t be turned into text/],
    [geminiReply("x", { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }), /couldn’t be turned into text/],
    [geminiReply("x", { candidates: [{ content: { parts: [{ text: "Wide shot of the" }] }, finishReason: "MAX_TOKENS" }] }), /shorter voice note/],
  ];
  for (const [reply, message] of cases) {
    mockGemini(reply);
    const response = await POST(upload(WAV));
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, message);
  }
});

test("usage comes only from usageMetadata: thinking tokens count as output, cached tokens are kept, missing is zero", () => {
  assert.deepEqual(
    geminiUsage(
      {
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 50, thoughtsTokenCount: 20, cachedContentTokenCount: 300, totalTokenCount: 970 },
        modelVersion: "gemini-2.5-flash-001",
      },
      "gemini-2.5-flash",
    ),
    { step: "transcribe", model: "gemini-2.5-flash-001", inputTokens: 900, outputTokens: 70, totalTokens: 970, cachedTokens: 300 },
  );
  assert.deepEqual(geminiUsage({}, "gemini-2.5-flash"), {
    step: "transcribe",
    model: "gemini-2.5-flash",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("the transcript is the plain text of every non-thought part, joined and trimmed", async () => {
  mockGemini(
    geminiReply("", {
      candidates: [
        {
          content: { parts: [{ text: "thinking…", thought: true }, { text: "  Fade in. " }, { text: "Wide shot of the pier.\n" }] },
          finishReason: "STOP",
        },
      ],
    }),
  );
  const response = await POST(upload(WAV));
  assert.equal((await response.json()).text, "Fade in. Wide shot of the pier.");
});

test("one wrapping pair of quotes or a code fence is removed; anything else is kept as said", async () => {
  const cases: [string, string][] = [
    ['"Fade in on the pier."', "Fade in on the pier."],
    ["“Fade in on the pier.”", "Fade in on the pier."],
    ["'Fade in on the pier.'", "Fade in on the pier."],
    ["```\nFade in on the pier.\n```", "Fade in on the pier."],
    ["```text\nFade in.\nCut to Mara.\n```", "Fade in.\nCut to Mara."],
    ["```Fade in.```", "Fade in."],
    ['"Go," she says, "now."', '"Go," she says, "now."'],
    ["'Don't go,' she says.'", "'Don't go,' she says.'"],
    ['He says "fade in"', 'He says "fade in"'],
    ['""', ""],
  ];
  for (const [raw, expected] of cases) assert.equal(unwrapTranscript(raw), expected, raw);

  mockGemini(geminiReply('```\n"Mara climbs the stairs."\n```'));
  assert.equal((await (await POST(upload(WAV))).json()).text, '"Mara climbs the stairs."', "only one layer is removed");
});

test("every transcript is cleaned in code before it is returned: fillers, doubled words and near-miss names", async () => {
  const probe =
    "Ashwin walks through the dark forest at stormy dusk. Um, the camera starts on a wide shot, then a slow dolly in to a close-up of the old house.";
  mockGemini(geminiReply(probe));
  const hint = encodeTranscribeHint({ title: "Night Walk", names: ["Aswin", "Old House"] });
  const response = await POST(upload(WAV, { "x-transcribe-hint": hint }));
  assert.equal(response.status, 200);
  const { text, usage } = await response.json();
  assert.equal(
    text,
    "Aswin walks through the dark forest at stormy dusk. The camera starts on a wide shot, then a slow dolly in to a close-up of the old house.",
  );
  assert.deepEqual(usage, { step: "transcribe", model: "gemini-3.5-transcribe", inputTokens: 812, outputTokens: 40, totalTokens: 852 });

  const transcriber = createGeminiTranscriber({ apiKey: KEY, model: DEFAULT_GEMINI_TRANSCRIBE_MODEL });
  mockGemini(geminiReply("Uh, the the camera finds Ashwin."));
  const direct = await transcriber.transcribe({
    audio: WAV,
    format: "wav",
    hint: { title: "", names: ["Aswin"] },
    signal: new AbortController().signal,
  });
  assert.equal(direct.text, "The camera finds Aswin.");
  assert.equal(transcriber.provider, "gemini");
  assert.equal(transcriber.model, DEFAULT_GEMINI_TRANSCRIBE_MODEL);
});

test("the request body builder is shared by every model and never varies by model id", () => {
  const body = geminiTranscribeBody({ audio: WAV, format: "wav", hint: EMPTY_HINT });
  assert.deepEqual(body.generationConfig, { temperature: 0, maxOutputTokens: GEMINI_TRANSCRIBE_MAX_OUTPUT_TOKENS });
  assert.equal(body.contents[0].parts[0].text, transcriptionPrompt(EMPTY_HINT));
  assert.ok("inline_data" in body.contents[0].parts[1]);
});

test("a call that hangs past the timeout is a 504 TranscriptionError, and a stop is reported as stopped", async () => {
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const transcriber = createGeminiTranscriber({ apiKey: KEY, model: DEFAULT_GEMINI_TRANSCRIBE_MODEL, timeoutMs: 20 });
  // AbortSignal.timeout's timer is unref'd; keep the loop alive until it fires.
  const keepAlive = setTimeout(() => {}, 1_000);
  await assert.rejects(
    transcriber.transcribe({ audio: WAV, format: "wav", hint: EMPTY_HINT, signal: new AbortController().signal }),
    (error: unknown) => error instanceof TranscriptionError && error.failure === "timeout",
  );
  clearTimeout(keepAlive);
  const controller = new AbortController();
  const pending = transcriber.transcribe({ audio: WAV, format: "wav", hint: EMPTY_HINT, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof TranscriptionError && error.failure === "stopped");
});

test("the route rejects a malformed or over-limit hint with 400 before reading the audio", async () => {
  const sent = mockGemini(geminiReply("x"));
  const bad = [
    "not base64!",
    "abc",
    hintHeader("not json"),
    hintHeader({ title: "T" }),
    hintHeader({ title: "T", names: [], extra: true }),
    hintHeader({ title: "x".repeat(MAX_HINT_TITLE + 1), names: [] }),
    hintHeader({ title: "T", names: Array.from({ length: MAX_HINT_NAMES + 1 }, (_, index) => `N${index}`) }),
    hintHeader({ title: "T", names: ["x".repeat(MAX_HINT_NAME + 1)] }),
    hintHeader({ title: "T", names: [7] }),
    "A".repeat(5_000),
    Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString("base64"),
  ];
  for (const header of bad) {
    const response = await POST(upload(WAV, { "x-transcribe-hint": header }));
    assert.equal(response.status, 400, header.slice(0, 40));
    assert.equal((await response.json()).error, INVALID_HINT_MESSAGE);
  }
  assert.equal(sent.length, 0);
});

test("the route still enforces type, size and byte checks with a valid hint", async () => {
  const sent = mockGemini(geminiReply("x"));
  const hint = encodeTranscribeHint({ title: "T", names: ["Mara"] });
  assert.equal((await POST(upload(WAV, { "x-audio-extension": "ogg", "x-transcribe-hint": hint }))).status, 415);
  assert.equal((await POST(upload(WAV, { "x-audio-type": "audio/mpeg", "x-transcribe-hint": hint }))).status, 415);
  assert.equal((await POST(upload(MP3, { "x-transcribe-hint": hint }))).status, 415);
  assert.equal((await POST(upload(new Uint8Array(4_000_001), { "x-transcribe-hint": hint }))).status, 413);
  assert.equal(sent.length, 0);
});

test("the hint is cleaned on the server: control characters removed, repeats dropped", async () => {
  const sent = mockGemini(geminiReply("x"));
  const header = hintHeader({ title: "The\u0000 Keeper\n", names: ["Mara", " mara ", "Ra\u202Evi", "José", ""] });
  assert.equal((await POST(upload(WAV, { "x-transcribe-hint": header }))).status, 200);
  assert.ok(sent[0].body.contents[0].parts[0].text.endsWith("Project title: The Keeper\nNames in this project: Mara; Ra vi; José"));
});
