import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { POST as imagePost } from "../src/app/api/story/image/route.ts";
import { POST as importPost } from "../src/app/api/story/import/route.ts";
import { POST as transcribePost } from "../src/app/api/story/transcribe/route.ts";
import { readPdfText } from "../src/lib/pdf-text.ts";
import {
  rollbackTurn,
  STOP_LABEL,
  STOPPED_DRAFT_MESSAGE,
  STOPPED_MESSAGE,
  stoppedNotice,
  stoppedResult,
} from "../src/lib/request-stop.ts";
import { analyseImage } from "../src/lib/server/image-analysis.ts";
import { type ChatMessage, createSession, type StorySession } from "../src/lib/session.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";
import {
  analyzeImage,
  askDirector,
  askIdeas,
  askInterview,
  checkEngagement,
  checkOriginality,
  createDigest,
  generatePlan,
  importDocument,
  transcribeVoice,
} from "../src/lib/studio-agent.ts";

const PLAN: ShotPlan = { title: "The Keeper", logline: "", intent: "", characters: [], locations: [], scenes: [], reviewNotes: [] };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Behaves like the browser: the request hangs until its signal aborts, then rejects. */
function hangingFetch(): { signals: (AbortSignal | undefined)[]; called: Promise<void> } {
  const signals: (AbortSignal | undefined)[] = [];
  let markCalled = () => {};
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    // The OpenAI SDK probes `data:` URLs before multipart uploads.
    if (String(url).startsWith("data:")) return originalFetch(url, init);
    signals.push(init?.signal ?? undefined);
    markCalled();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(abortError());
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }) as typeof fetch;
  return { signals, called };
}

function recordingFetch(body: unknown): (AbortSignal | undefined)[] {
  const signals: (AbortSignal | undefined)[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return signals;
}

test("an aborted JSON request resolves to a stopped result, never an error to show", async () => {
  const { called } = hangingFetch();
  const controller = new AbortController();
  const pending = askInterview("The Keeper", [], undefined, { signal: controller.signal });
  await called;
  controller.abort();
  const result = await pending;
  assert.deepEqual(result, { ok: false, error: STOPPED_MESSAGE, stopped: true });
  assert.ok(!JSON.stringify(result).includes("couldn’t connect"));
});

test("a signal that is already aborted stops before any network call", async () => {
  const signals = recordingFetch({});
  const controller = new AbortController();
  controller.abort();
  const result = await generatePlan("The Keeper", [], [], undefined, { signal: controller.signal });
  assert.deepEqual(result, stoppedResult());
  assert.equal(signals.length, 0);
});

test("a network failure without a stop is still a plain error", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  const result = await askInterview("The Keeper", [], undefined, { signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && !result.stopped);
  assert.ok(!result.ok && result.error !== STOPPED_MESSAGE);
});

test("each studio call forwards the caller's signal to fetch", async () => {
  const signal = new AbortController().signal;
  const calls: [string, () => Promise<unknown>][] = [
    ["askInterview", () => askInterview("The Keeper", [], undefined, { signal })],
    ["generatePlan", () => generatePlan("The Keeper", [], [], undefined, { signal })],
    ["askDirector", () => askDirector({ plan: PLAN, messages: [], message: "Tighten scene 1" }, { signal })],
    ["createDigest", () => createDigest("story.txt", "Mara finds the letter.", { signal })],
    ["askIdeas", () => askIdeas({ mode: "generate", direction: "Mystery", answers: [], avoid: [] }, { signal })],
    ["checkOriginality", () => checkOriginality({ title: "T", plan: PLAN, references: false }, 0, { signal })],
    ["checkEngagement", () => checkEngagement({ title: "T", plan: PLAN }, 0, { signal })],
    ["transcribeVoice", () => transcribeVoice(new File([WAV], "note.wav", { type: "audio/wav" }), { signal })],
    ["analyzeImage", () => analyzeImage(new File([PNG], "frame.png", { type: "image/png" }), { signal })],
  ];
  for (const [name, call] of calls) {
    const signals = recordingFetch({});
    await call();
    assert.equal(signals.length, 1, name);
    assert.equal(signals[0], signal, name);
  }
});

test("stopping an upload resolves to a stopped result for audio and images", async () => {
  for (const send of [
    (signal: AbortSignal) => transcribeVoice(new File([WAV], "note.wav", { type: "audio/wav" }), { signal }),
    (signal: AbortSignal) => analyzeImage(new File([PNG], "frame.png", { type: "image/png" }), { signal }),
  ]) {
    const { called } = hangingFetch();
    const controller = new AbortController();
    const pending = send(controller.signal);
    await called;
    controller.abort();
    assert.deepEqual(await pending, stoppedResult());
  }
});

async function makePdf(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(text, { x: 20, y: 770, size: 12, font });
  return Uint8Array.from(await doc.save());
}

test("stopping a document import returns a stopped result and stops the PDF read", async () => {
  const pdf = await makePdf("Mara finds the letter under the lighthouse stairs.");
  const file = new File([pdf], "story.pdf", { type: "application/pdf" });

  const controller = new AbortController();
  const pending = importDocument(file, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, stoppedResult());

  const reading = new AbortController();
  const read = readPdfText(file, "“story.pdf”", reading.signal);
  reading.abort();
  const outcome = await read;
  assert.equal(outcome.ok, false);

  const text = new File(["Mara finds the letter."], "story.txt", { type: "text/plain" });
  const txt = new AbortController();
  const importing = importDocument(text, { signal: txt.signal });
  txt.abort();
  assert.deepEqual(await importing, stoppedResult());

  const done = await importDocument(text, { signal: new AbortController().signal });
  assert.equal(done.ok, true);
});

test("stoppedNotice says the draft is back only when it was put back", () => {
  assert.equal(stoppedNotice(true), STOPPED_DRAFT_MESSAGE);
  assert.equal(stoppedNotice(false), STOPPED_MESSAGE);
  assert.equal(STOP_LABEL, "Stop the current request");
});

test("rollbackTurn removes the optimistic message and restores what it was given", () => {
  const question = "Who finds the letter?";
  const agent: ChatMessage = { id: "a1", role: "agent", text: question };
  const user: ChatMessage = { id: "u1", role: "user", text: "Mara", answerIndex: 0 };
  const before: StorySession = { ...createSession("The Keeper"), messages: [agent], pendingQuestion: question };
  const optimistic: StorySession = {
    ...before,
    messages: [agent, user],
    answered: [{ question, answer: "Mara" }],
    pendingQuestion: null,
  };

  const discovery = rollbackTurn(optimistic, {
    messageId: user.id,
    answered: before.answered,
    pendingQuestion: before.pendingQuestion,
  });
  assert.deepEqual(discovery.messages, [agent]);
  assert.deepEqual(discovery.answered, []);
  assert.equal(discovery.pendingQuestion, question);
  assert.notEqual(discovery, optimistic);
  assert.deepEqual(optimistic.messages, [agent, user], "the input session is not mutated");

  const chat = rollbackTurn(optimistic, { messageId: user.id });
  assert.deepEqual(chat.messages, [agent]);
  assert.equal(chat.answered, optimistic.answered, "answers stay when not named");
  assert.equal(chat.pendingQuestion, null, "an unnamed pending question stays as it is");

  const planOnly = rollbackTurn(optimistic, { answered: before.answered });
  assert.equal(planOnly.messages, optimistic.messages);
  assert.deepEqual(planOnly.answered, []);
});

test("analyseImage passes the abort signal to the model call", async (t) => {
  t.mock.method(console, "info", () => {});
  const options: unknown[] = [];
  const client = {
    responses: {
      parse: async (_body: unknown, requestOptions?: unknown) => {
        options.push(requestOptions);
        return {
          status: "completed",
          output_parsed: {
            summary: "A lit window",
            composition: "",
            lighting: "",
            cameraAngle: "",
            colour: "",
            environment: "",
            mood: "",
            shotIdeas: "",
          },
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
      },
    },
  } as unknown as Parameters<typeof analyseImage>[0];
  const signal = new AbortController().signal;
  await analyseImage(client, PNG, "image/png", "Window", { signal });
  assert.deepEqual(options, [{ signal }]);
});

async function withKey(run: () => Promise<void>) {
  const saved = { openai: process.env.OPENAI_API_KEY, gemini: process.env.GEMINI_API_KEY };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  try {
    await run();
  } finally {
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.openai;
    if (saved.gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.gemini;
  }
}

test("image and transcribe routes cancel the provider call when the browser stops the request", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  const routes: [string, (request: Request) => Promise<Response>, Request, AbortController][] = [];
  const image = new AbortController();
  routes.push([
    "image",
    imagePost,
    new Request("http://localhost/api/story/image", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-image-type": "image/png" },
      body: PNG,
      signal: image.signal,
    }),
    image,
  ]);
  const audio = new AbortController();
  routes.push([
    "transcribe",
    transcribePost,
    new Request("http://localhost/api/story/transcribe", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-audio-extension": "wav" },
      body: WAV,
      signal: audio.signal,
    }),
    audio,
  ]);
  await withKey(async () => {
    for (const [name, post, request, controller] of routes) {
      const { signals, called } = hangingFetch();
      const response = post(request);
      await called;
      assert.equal(signals.length, 1, name);
      assert.equal(signals[0]?.aborted, false, name);
      controller.abort();
      const settled = await response;
      assert.equal(signals[0]?.aborted, true, `${name}: the provider request is cancelled`);
      assert.ok(settled.status >= 400, name);
    }
  });
});

test("the import route stops before parsing when the browser has stopped the request", async (t) => {
  const warned: unknown[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warned.push(args));
  const pdf = await makePdf("Mara finds the letter under the lighthouse stairs.");
  const controller = new AbortController();
  controller.abort();
  const response = await importPost(
    new Request("http://localhost/api/story/import", {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: pdf,
      signal: controller.signal,
    }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /interrupted/);
  assert.equal(warned.length, 0);

  const live = await importPost(
    new Request("http://localhost/api/story/import", {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: pdf,
      signal: new AbortController().signal,
    }),
  );
  assert.equal(live.status, 200);
});
