import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchModelCatalog,
  MODEL_PREFERENCES_KEY,
  modelPreferenceHeaders,
  NO_MODEL_PREFERENCES,
  parseModelPreferences,
  readModelPreferences,
  saveModelPreference,
  testModel,
} from "../src/lib/model-preferences.ts";
import { STORY_MODEL, STORY_MODEL_HEADER, VOICE_MODEL_HEADER } from "../src/lib/models.ts";
import { createDigest } from "../src/lib/studio-agent.ts";

type Hooks = { after: (fn: () => void) => void };

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

function installStorage(t: Hooks, get: () => unknown) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });
}

function memoryStorage(t: Hooks) {
  const storage = new MemoryStorage();
  installStorage(t, () => storage);
  return storage;
}

test("no storage at all: nothing is read, saving reports failure, no headers are sent", (t) => {
  installStorage(t, () => undefined);
  assert.equal(readModelPreferences(), NO_MODEL_PREFERENCES);
  assert.equal(saveModelPreference("story", "gpt-5-mini"), false);
  assert.deepEqual(modelPreferenceHeaders(), {});
});

test("storage that throws on access, read or write never breaks the app", (t) => {
  installStorage(t, () => {
    throw new DOMException("Blocked", "SecurityError");
  });
  assert.equal(readModelPreferences(), NO_MODEL_PREFERENCES);
  assert.equal(saveModelPreference("story", "gpt-5-mini"), false);
  assert.deepEqual(modelPreferenceHeaders(), {});

  const failing = {
    getItem: () => {
      throw new Error("read failed");
    },
    setItem: () => {
      throw new DOMException("Full", "QuotaExceededError");
    },
    removeItem: () => {},
  };
  installStorage(t, () => failing);
  assert.equal(readModelPreferences(), NO_MODEL_PREFERENCES);
  assert.equal(saveModelPreference("voice", "gemini-2.5-pro"), false);
});

test("saves, reads back, clears and keeps the snapshot stable while unchanged", (t) => {
  const storage = memoryStorage(t);
  assert.equal(saveModelPreference("story", "gpt-5-mini"), true);
  assert.equal(saveModelPreference("voice", "gemini-2.5-pro"), true);
  const first = readModelPreferences();
  assert.deepEqual(first, { story: "gpt-5-mini", voice: "gemini-2.5-pro" });
  assert.equal(readModelPreferences(), first);
  assert.equal(saveModelPreference("story", null), true);
  assert.deepEqual(readModelPreferences(), { voice: "gemini-2.5-pro" });
  assert.equal(saveModelPreference("voice", null), true);
  assert.equal(storage.items.has(MODEL_PREFERENCES_KEY), false);
  assert.equal(saveModelPreference("story", "gpt 5; drop"), false);
  assert.deepEqual(readModelPreferences(), {});
});

test("corrupt or tampered stored values are dropped, valid ones kept", () => {
  assert.equal(parseModelPreferences("{not json"), NO_MODEL_PREFERENCES);
  assert.equal(parseModelPreferences("42"), NO_MODEL_PREFERENCES);
  assert.deepEqual(parseModelPreferences(JSON.stringify({ story: "gpt-5\r\nx-evil: 1", voice: "gemini-2.5-pro" })), {
    voice: "gemini-2.5-pro",
  });
  assert.deepEqual(parseModelPreferences(JSON.stringify({ story: 5, extra: "x" })), {});
});

test("modelPreferenceHeaders carries only the saved choices", () => {
  assert.deepEqual(modelPreferenceHeaders({}), {});
  assert.deepEqual(modelPreferenceHeaders({ story: "o3" }), { [STORY_MODEL_HEADER]: "o3" });
  assert.deepEqual(modelPreferenceHeaders({ story: "o3", voice: "gemini-2.5-pro" }), {
    [STORY_MODEL_HEADER]: "o3",
    [VOICE_MODEL_HEADER]: "gemini-2.5-pro",
  });
});

function captureFetch(t: Hooks, respond: () => Response) {
  const original = globalThis.fetch;
  const sent: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

const digestReply = () => Response.json({ digest: "Short version.", chunks: 1, usage: [] });

test("postJson sends the model headers only when a choice is saved", async (t) => {
  memoryStorage(t);
  const sent = captureFetch(t, digestReply);
  await createDigest("story.txt", "A story.");
  saveModelPreference("story", "gpt-5-mini");
  await createDigest("story.txt", "A story.");
  saveModelPreference("voice", "gemini-2.5-pro");
  await createDigest("story.txt", "A story.");
  const headers = sent.map(({ init }) => new Headers(init?.headers));
  assert.equal(headers[0].get(STORY_MODEL_HEADER), null);
  assert.equal(headers[0].get(VOICE_MODEL_HEADER), null);
  assert.equal(headers[1].get(STORY_MODEL_HEADER), "gpt-5-mini");
  assert.equal(headers[1].get(VOICE_MODEL_HEADER), null);
  assert.equal(headers[2].get(VOICE_MODEL_HEADER), "gemini-2.5-pro");
  for (const header of headers) assert.equal(header.get("Content-Type"), "application/json");
});

const catalog = {
  story: { default: STORY_MODEL, options: [{ id: STORY_MODEL }], status: "ok", message: "Listed." },
  voice: { provider: "gemini", configured: false, default: "gemini-2.5-flash", options: [], status: "no_key", message: "Not set up." },
};

test("fetchModelCatalog validates the response and bypasses the browser copy on refresh", async (t) => {
  let reply: () => Response = () => Response.json(catalog);
  const sent = captureFetch(t, () => reply());
  const loaded = await fetchModelCatalog();
  assert.ok(loaded.ok && loaded.value.story.default === STORY_MODEL);
  await fetchModelCatalog({ refresh: true });
  assert.deepEqual(
    sent.map(({ init }) => init?.cache),
    ["default", "reload"],
  );
  reply = () => Response.json({ story: { default: "x y" } });
  assert.deepEqual(await fetchModelCatalog(), { ok: false, error: "Couldn’t load the model list. Try Refresh." });
});

test("testModel returns the server's result or its plain error", async (t) => {
  let reply: () => Response = () => Response.json({ ok: true, ms: 1200, message: "Works — 1.2 s" });
  const sent = captureFetch(t, () => reply());
  assert.deepEqual(await testModel("story", "o3"), { ok: true, value: { ok: true, ms: 1200, message: "Works — 1.2 s" } });
  assert.deepEqual(JSON.parse(String(sent[0].init?.body)), { kind: "story", model: "o3" });
  reply = () => Response.json({ error: "This model can’t be used for this job." }, { status: 400 });
  assert.deepEqual(await testModel("voice", "gpt-5"), { ok: false, error: "This model can’t be used for this job." });
  reply = () => {
    throw new TypeError("offline");
  };
  assert.deepEqual(await testModel("voice", "gemini-2.5-pro"), { ok: false, error: "The test couldn’t run. Try again." });
});
