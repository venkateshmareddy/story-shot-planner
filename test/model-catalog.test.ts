import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../src/app/api/settings/models/route.ts";
import { POST as testRoute } from "../src/app/api/settings/models/test/route.ts";
import { POST as directorRoute } from "../src/app/api/story/director/route.ts";
import { POST as planRoute } from "../src/app/api/story/plan/route.ts";
import {
  MAX_MODEL_OPTIONS,
  type ModelCatalog,
  modelCatalogSchema,
  modelTestResponseSchema,
  STORY_MODEL,
  STORY_MODEL_HEADER,
  VOICE_MODEL_HEADER,
} from "../src/lib/models.ts";
import {
  catalogOptions,
  DEFAULT_VOICE_MODEL,
  GEMINI_API_URL,
  isModelFamily,
  MAX_GEMINI_PAGES,
  NOT_SET_UP,
  resolveStoryModel,
  resolveVoiceModel,
  STORY_TEST_MAX_OUTPUT_TOKENS,
  TEST_MESSAGES,
} from "../src/lib/server/model-catalog.ts";
import { pinStoryModel } from "../src/lib/server/openai.ts";

const OPENAI_KEY = "sk-test-not-real";
const GEMINI_KEY = "gm-test-not-real";
const ENV_NAMES = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_TRANSCRIBE_MODEL",
  "ALLOWED_STORY_MODELS",
  "ALLOWED_VOICE_MODELS",
] as const;
type EnvName = (typeof ENV_NAMES)[number];

type Hooks = { after: (fn: () => void) => void; mock: { method: (object: object, name: string, impl: () => void) => void } };

function env(t: Hooks, values: Partial<Record<EnvName, string>>) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  t.after(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
}

function quiet(t: Hooks) {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Sent = { url: string; init?: RequestInit; body?: Record<string, unknown> };

// Stands in for api.openai.com and Google, so nothing leaves the machine.
function mockFetch(t: Hooks, handle: (sent: Sent) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.ok(url.startsWith("https://api.openai.com/") || url.startsWith(GEMINI_API_URL), url);
    const entry: Sent = { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    sent.push(entry);
    return handle(entry);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

const headerOf = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

const withHeader = (name: string, value: string) => ({ headers: new Headers({ [name]: value }) });

// --- Filtering and sorting ---

test("story family keeps text and reasoning chat models and drops every other kind", () => {
  for (const id of [STORY_MODEL, "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-2024-08-06", "o3", "o4-mini", "o1"]) {
    assert.ok(isModelFamily("story", id), id);
  }
  for (const id of [
    "text-embedding-3-small",
    "gpt-4o-mini-tts",
    "whisper-1",
    "gpt-4o-transcribe",
    "gpt-4o-audio-preview",
    "gpt-realtime",
    "gpt-image-1",
    "dall-e-3",
    "omni-moderation-latest",
    "gpt-4o-search-preview",
    "computer-use-preview",
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo",
    "gpt-4",
    "gpt-4-turbo",
    "o3-deep-research",
    "gpt-5-codex",
    "o1-mini",
    "davinci-002",
    "ft:gpt-4o-mini:org:name:abc",
    "gemini-2.5-flash",
    "gpt 5",
    `gpt-${"x".repeat(80)}`,
  ]) {
    assert.ok(!isModelFamily("story", id), id);
  }
});

test("voice family keeps Gemini text models and drops speech, image, embedding and live models", () => {
  for (const id of ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-flash-001"]) {
    assert.ok(isModelFamily("voice", id), id);
  }
  for (const id of [
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-flash-image",
    "gemini-embedding-001",
    "gemini-2.0-flash-live-001",
    "gemini-2.5-flash-native-audio-latest",
    "gemma-3-27b-it",
    "gpt-5",
    "models/gemini-2.5-flash",
  ]) {
    assert.ok(!isModelFamily("voice", id), id);
  }
});

test("options put the default first, sort the rest naturally, drop duplicates and cap the list", (t) => {
  env(t, {});
  const options = catalogOptions("story", ["o3", "gpt-5", "gpt-4.1", STORY_MODEL, "whisper-1", "gpt-5", "gpt-10"]);
  assert.deepEqual(
    options.map((option) => option.id),
    [STORY_MODEL, "gpt-4.1", "gpt-5", "gpt-10", "o3"],
  );
  const many = Array.from({ length: MAX_MODEL_OPTIONS + 50 }, (_, index) => `gpt-${index}`);
  assert.equal(catalogOptions("story", many).length, MAX_MODEL_OPTIONS);
  assert.equal(catalogOptions("voice", ["gemini-2.5-pro", DEFAULT_VOICE_MODEL])[0].id, DEFAULT_VOICE_MODEL);
});

test("the env allowlist limits the options but always keeps the default", (t) => {
  env(t, { ALLOWED_STORY_MODELS: " gpt-5-mini , o3 ,," });
  assert.deepEqual(
    catalogOptions("story", ["gpt-5", "gpt-5-mini", "o3", STORY_MODEL]).map((option) => option.id),
    [STORY_MODEL, "gpt-5-mini", "o3"],
  );
});

// --- Header validation ---

test("resolveStoryModel accepts a valid, allowed header and falls back to the default otherwise", (t) => {
  env(t, {});
  assert.equal(resolveStoryModel({ headers: new Headers() }), STORY_MODEL);
  assert.equal(resolveStoryModel(withHeader(STORY_MODEL_HEADER, "gpt-5-mini")), "gpt-5-mini");
  assert.equal(resolveStoryModel(withHeader(STORY_MODEL_HEADER, "  o3  ")), "o3");
  for (const bad of ["", "   ", "gpt-5/../../v1", "gpt 5", "whisper-1", "gemini-2.5-flash", `gpt-${"9".repeat(80)}`]) {
    assert.equal(resolveStoryModel(withHeader(STORY_MODEL_HEADER, bad)), STORY_MODEL, bad);
  }
});

test("with ALLOWED_STORY_MODELS set only those ids (and the default) are accepted", (t) => {
  env(t, { ALLOWED_STORY_MODELS: "gpt-5-mini" });
  assert.equal(resolveStoryModel(withHeader(STORY_MODEL_HEADER, "gpt-5-mini")), "gpt-5-mini");
  assert.equal(resolveStoryModel(withHeader(STORY_MODEL_HEADER, "gpt-5")), STORY_MODEL);
  assert.equal(resolveStoryModel(withHeader(STORY_MODEL_HEADER, STORY_MODEL)), STORY_MODEL);
});

test("resolveVoiceModel uses the same rules for Gemini, with GEMINI_TRANSCRIBE_MODEL as the default", (t) => {
  env(t, {});
  assert.equal(resolveVoiceModel({ headers: new Headers() }), DEFAULT_VOICE_MODEL);
  assert.equal(resolveVoiceModel(withHeader(VOICE_MODEL_HEADER, "gemini-2.5-pro")), "gemini-2.5-pro");
  assert.equal(resolveVoiceModel(withHeader(VOICE_MODEL_HEADER, "gpt-5")), DEFAULT_VOICE_MODEL);
  assert.equal(resolveVoiceModel(withHeader(VOICE_MODEL_HEADER, "gemini-2.5-flash-preview-tts")), DEFAULT_VOICE_MODEL);
  process.env.GEMINI_TRANSCRIBE_MODEL = "gemini-2.5-flash-lite";
  process.env.ALLOWED_VOICE_MODELS = "gemini-2.0-flash";
  assert.equal(resolveVoiceModel({ headers: new Headers() }), "gemini-2.5-flash-lite");
  assert.equal(resolveVoiceModel(withHeader(VOICE_MODEL_HEADER, "gemini-2.5-pro")), "gemini-2.5-flash-lite");
  assert.equal(resolveVoiceModel(withHeader(VOICE_MODEL_HEADER, "gemini-2.0-flash")), "gemini-2.0-flash");
});

// --- Story routes use the resolved model ---

const responsesFailure = () => json({ error: { message: "boom", type: "server_error" } }, 500);

test("the plan route sends the requested story model and ignores an invalid one", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY });
  const sent = mockFetch(t, responsesFailure);
  const post = (model?: string) =>
    planRoute(
      new Request("http://localhost/api/story/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(model ? { [STORY_MODEL_HEADER]: model } : {}) },
        body: JSON.stringify({ step: "interview", story: "The Letter", answered: [] }),
      }),
    );
  await post("gpt-5-mini");
  await post("text-embedding-3-small");
  await post();
  assert.deepEqual(
    sent.map((entry) => entry.body?.model),
    ["gpt-5-mini", STORY_MODEL, STORY_MODEL],
  );
});

test("the director route sends the requested story model on every call", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY });
  const sent = mockFetch(t, responsesFailure);
  const shot = {
    seconds: 4,
    framing: "Medium shot",
    camera: "Static tripod",
    characters: ["Elias"],
    location: "Kitchen",
    action: "Elias reads the letter.",
    dialogue: [],
    emotion: "Hope",
    sound: "Kettle hiss",
  };
  const plan = {
    title: "The Letter",
    logline: "A widower finds a letter.",
    intent: "Quiet grief turning to hope.",
    characters: [{ name: "Elias", role: "Lead", look: "Grey cardigan", personality: "Reserved", voice: "Low" }],
    locations: [{ name: "Kitchen", description: "Morning light" }],
    scenes: [{ title: "Morning", shots: [shot] }],
    reviewNotes: [],
  };
  const response = await directorRoute(
    new Request("http://localhost/api/story/director", {
      method: "POST",
      headers: { "Content-Type": "application/json", [STORY_MODEL_HEADER]: "o3" },
      body: JSON.stringify({ plan, messages: [], message: "Review the camera work and the sound." }),
    }),
  );
  assert.ok(response.status >= 400);
  assert.ok(sent.length >= 1);
  for (const entry of sent) assert.equal(entry.body?.model, "o3");
});

test("pinStoryModel makes a helper's own requests use the chosen model and leaves the default untouched", async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return { status: "completed" };
      },
    },
  } as unknown as Parameters<typeof pinStoryModel>[0];
  assert.equal(pinStoryModel(client, STORY_MODEL), client);
  const pinned = pinStoryModel(client, "gpt-5-mini");
  await pinned.responses.parse({ model: STORY_MODEL, input: "x" });
  assert.equal(bodies[0].model, "gpt-5-mini");
});

// --- GET /api/settings/models ---

const openAIModels = { object: "list", data: ["gpt-5", STORY_MODEL, "whisper-1", "text-embedding-3-small", "o3"].map((id) => ({ id, object: "model", created: 0, owned_by: "system" })) };

const geminiPage = (names: string[], nextPageToken?: string) => ({
  models: names.map((name) => ({
    name: `models/${name}`,
    supportedGenerationMethods: name.includes("embedding") ? ["embedContent"] : ["generateContent", "countTokens"],
  })),
  ...(nextPageToken ? { nextPageToken } : {}),
});

async function getCatalog(): Promise<{ status: number; body: ModelCatalog; text: string; cache: string | null }> {
  const response = await GET(new Request("http://localhost/api/settings/models"));
  const text = await response.text();
  const body = modelCatalogSchema.parse(JSON.parse(text));
  return { status: response.status, body, text, cache: response.headers.get("Cache-Control") };
}

test("GET lists both providers' usable models, default first, following Gemini's pages", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY, GEMINI_API_KEY: GEMINI_KEY });
  const sent = mockFetch(t, ({ url, init }) => {
    if (url === "https://api.openai.com/v1/models") return json(openAIModels);
    assert.equal(headerOf(init, "x-goog-api-key"), GEMINI_KEY);
    const token = new URL(url).searchParams.get("pageToken");
    return json(
      token
        ? geminiPage(["gemini-2.5-pro", "gemini-2.5-flash-preview-tts"])
        : geminiPage(["gemini-2.0-flash", DEFAULT_VOICE_MODEL, "gemini-embedding-001", "gemma-3-27b-it"], "page-2"),
    );
  });
  const { status, body, text, cache } = await getCatalog();
  assert.equal(status, 200);
  assert.equal(body.story.status, "ok");
  assert.equal(body.story.default, STORY_MODEL);
  assert.deepEqual(
    body.story.options.map((option) => option.id),
    [STORY_MODEL, "gpt-5", "o3"],
  );
  assert.equal(body.voice.status, "ok");
  assert.equal(body.voice.configured, true);
  assert.equal(body.voice.provider, "gemini");
  assert.deepEqual(
    body.voice.options.map((option) => option.id),
    [DEFAULT_VOICE_MODEL, "gemini-2.0-flash", "gemini-2.5-pro"],
  );
  assert.equal(sent.filter((entry) => entry.url.startsWith(GEMINI_API_URL)).length, 2);
  assert.equal(cache, "private, max-age=60");
  for (const secret of [OPENAI_KEY, GEMINI_KEY]) assert.ok(!text.includes(secret));
});

test("GET reports no_key for each provider without calling it", async (t) => {
  quiet(t);
  env(t, {});
  const sent = mockFetch(t, () => json({}));
  const { body } = await getCatalog();
  assert.equal(sent.length, 0);
  assert.deepEqual(body.story, { default: STORY_MODEL, options: [], status: "no_key", message: NOT_SET_UP.story });
  assert.deepEqual(body.voice, {
    provider: "gemini",
    configured: false,
    default: DEFAULT_VOICE_MODEL,
    options: [],
    status: "no_key",
    message: NOT_SET_UP.voice,
  });
});

test("GET reports forbidden for refused keys and keeps each provider independent", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY, GEMINI_API_KEY: GEMINI_KEY });
  mockFetch(t, ({ url }) =>
    url.startsWith("https://api.openai.com/")
      ? json({ error: { message: "Incorrect API key provided: sk-test-not-real", type: "invalid_request_error" } }, 401)
      : json(geminiPage([DEFAULT_VOICE_MODEL])),
  );
  const { body, text, cache } = await getCatalog();
  assert.equal(body.story.status, "forbidden");
  assert.deepEqual(body.story.options, []);
  assert.match(body.story.message, /OPENAI_API_KEY/);
  assert.equal(body.voice.status, "ok");
  assert.ok(!text.includes(OPENAI_KEY) && !text.includes("Incorrect API key"));
  assert.equal(cache, "no-store");
});

test("GET reports unavailable when a provider errors, times out or answers in an unexpected shape", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY, GEMINI_API_KEY: GEMINI_KEY });
  let gemini: () => Response | Promise<Response> = () => {
    throw new TypeError("fetch failed");
  };
  mockFetch(t, ({ url }) => (url.startsWith("https://api.openai.com/") ? json({ error: { message: "down" } }, 500) : gemini()));
  let { body } = await getCatalog();
  assert.equal(body.story.status, "unavailable");
  assert.equal(body.voice.status, "unavailable");
  assert.equal(body.voice.configured, true);
  gemini = () => json({ models: "nope" });
  ({ body } = await getCatalog());
  assert.equal(body.voice.status, "unavailable");
  gemini = () => json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);
  ({ body } = await getCatalog());
  assert.equal(body.voice.status, "forbidden");
});

test("GET stops following Gemini pages at the cap", async (t) => {
  quiet(t);
  env(t, { GEMINI_API_KEY: GEMINI_KEY });
  let page = 0;
  const sent = mockFetch(t, () => json(geminiPage([`gemini-test-${page++}`], "more")));
  const { body } = await getCatalog();
  assert.equal(sent.length, MAX_GEMINI_PAGES);
  assert.equal(body.voice.status, "ok");
});

// --- POST /api/settings/models/test ---

const responsesBody = {
  id: "resp_test",
  object: "response",
  created_at: 0,
  status: "completed",
  incomplete_details: null,
  model: "gpt-5-mini-2026-01-01",
  output: [
    {
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
    },
  ],
  usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
};

const postTest = (body: unknown) =>
  testRoute(
    new Request("http://localhost/api/settings/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

test("the test route rejects bad requests and models outside the job's family before any call", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY, GEMINI_API_KEY: GEMINI_KEY });
  const sent = mockFetch(t, () => json({}));
  for (const body of [
    "{nope",
    {},
    { kind: "image", model: "gpt-5" },
    { kind: "story", model: "gpt 5" },
    { kind: "story", model: "gpt-5", extra: 1 },
  ]) {
    assert.equal((await postTest(body)).status, 400, JSON.stringify(body));
  }
  for (const body of [
    { kind: "story", model: "whisper-1" },
    { kind: "voice", model: "gpt-5" },
  ]) {
    const response = await postTest(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "This model can’t be used for this job.");
  }
  assert.equal((await postTest("x".repeat(2_000))).status, 413);
  assert.equal(sent.length, 0);
});

test("the story test makes one small structured call and reports the time and tokens", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY });
  const sent = mockFetch(t, () => json(responsesBody));
  const response = await postTest({ kind: "story", model: "gpt-5-mini" });
  assert.equal(response.status, 200);
  const result = modelTestResponseSchema.parse(await response.json());
  assert.equal(result.ok, true);
  assert.match(result.message, /^Works — \d+\.\d s$/);
  assert.deepEqual(result.usage, { model: "gpt-5-mini-2026-01-01", inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  assert.equal(sent.length, 1);
  const body = sent[0].body as { model: string; store: boolean; max_output_tokens: number; text: { format: { type: string } } };
  assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
  assert.equal(body.model, "gpt-5-mini");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, STORY_TEST_MAX_OUTPUT_TOKENS);
  assert.equal(body.text.format.type, "json_schema");
});

test("the story test turns provider failures into plain messages", async (t) => {
  quiet(t);
  env(t, { OPENAI_API_KEY: OPENAI_KEY });
  let status = 404;
  mockFetch(t, () => json({ error: { message: "The model `gpt-5` does not exist", type: "invalid_request_error" } }, status));
  const run = async () => modelTestResponseSchema.parse(await (await postTest({ kind: "story", model: "gpt-5" })).json());
  let result = await run();
  assert.deepEqual([result.ok, result.message], [false, TEST_MESSAGES.key]);
  status = 400;
  assert.equal((await run()).message, TEST_MESSAGES.unsupported);
  status = 429;
  assert.equal((await run()).message, TEST_MESSAGES.limit);
  status = 500;
  result = await run();
  assert.equal(result.message, TEST_MESSAGES.unreachable);
  assert.equal(result.usage, undefined);
});

test("a test without the provider's key says how to set it up", async (t) => {
  quiet(t);
  env(t, {});
  const sent = mockFetch(t, () => json({}));
  const story = await (await postTest({ kind: "story", model: STORY_MODEL })).json();
  const voice = await (await postTest({ kind: "voice", model: DEFAULT_VOICE_MODEL })).json();
  assert.deepEqual(story, { ok: false, ms: 0, reason: "not_set_up", message: NOT_SET_UP.story });
  assert.deepEqual(voice, { ok: false, ms: 0, reason: "not_set_up", message: NOT_SET_UP.voice });
  assert.equal(sent.length, 0);
});

test("the voice test sends the bundled speech clip to the chosen Gemini model and reports a busy model plainly", async (t) => {
  quiet(t);
  env(t, { GEMINI_API_KEY: GEMINI_KEY });
  const sent = mockFetch(t, () =>
    json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, 503),
  );
  const response = await postTest({ kind: "voice", model: "gemini-2.5-pro" });
  const text = await response.text();
  const result = modelTestResponseSchema.parse(JSON.parse(text));
  assert.deepEqual([result.ok, result.reason, result.message], [false, "busy", TEST_MESSAGES.busy]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.startsWith(`${GEMINI_API_URL}/models/gemini-2.5-pro`), sent[0].url);
  assert.equal(headerOf(sent[0].init, "x-goog-api-key"), GEMINI_KEY);
  assert.ok(String(sent[0].init?.body).includes("UklGR"), "the WAV clip travels inline");
  assert.ok(!text.includes(GEMINI_KEY));
});
