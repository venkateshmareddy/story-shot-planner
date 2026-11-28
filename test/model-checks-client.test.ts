import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECK_GAP_MS,
  CHECK_REASON_LABELS,
  CHECK_TTL_MS,
  checkedAgo,
  checkModels,
  checkResultFrom,
  checkSummary,
  checkTargets,
  defaultFailedNotice,
  dropFailedChoice,
  type Loaded,
  MAX_CHECK_MODELS,
  MODEL_CHECKS_KEY,
  type ModelCheckResult,
  modelChoiceView,
  NO_MODEL_CHECKS,
  parseModelChecks,
  readModelChecks,
  readModelPreferences,
  recordModelChecks,
  saveModelPreference,
  type testModel,
} from "../src/lib/model-preferences.ts";
import { MODEL_CHECK_REASONS, type ModelKind, type ModelTestResponse } from "../src/lib/models.ts";

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

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const MINUTE = 60_000;

const pass = (id: string, checkedAt = NOW): ModelCheckResult => ({ id, ok: true, ms: 900, checkedAt });
const fail = (id: string, reason: ModelCheckResult["reason"] = "busy", checkedAt = NOW): ModelCheckResult => ({
  id,
  ok: false,
  ms: 300,
  checkedAt,
  reason,
});

// --- Storage ---

test("check results are saved per job, read back and merged by model", (t) => {
  const storage = memoryStorage(t);
  assert.equal(recordModelChecks("voice", [fail("gemini-2.5-flash", "no_access")], NOW), true);
  recordModelChecks("voice", [pass("gemini-3.5-transcribe")], NOW);
  recordModelChecks("story", [pass("gpt-5-mini")], NOW);
  recordModelChecks("voice", [pass("gemini-2.5-flash", NOW + 1)], NOW + 1);
  const checks = readModelChecks();
  assert.equal(readModelChecks(), checks, "stable snapshot while storage is unchanged");
  assert.deepEqual(
    [...(checks.voice ?? [])].map((result) => [result.id, result.ok]).sort(),
    [
      ["gemini-2.5-flash", true],
      ["gemini-3.5-transcribe", true],
    ],
  );
  assert.deepEqual(checks.story, [pass("gpt-5-mini")]);
  const stored = JSON.parse(storage.getItem(MODEL_CHECKS_KEY) ?? "{}");
  assert.equal(stored.voice.length, 2);
});

test("results older than seven days are expired and dropped on the next save", (t) => {
  memoryStorage(t);
  const old = NOW - CHECK_TTL_MS - MINUTE;
  recordModelChecks("story", [pass("gpt-5-mini", old), pass("o3", old)], old);
  assert.equal(readModelChecks().story?.length, 2);
  const view = modelChoiceView({ defaultId: "gpt-5-mini", listed: ["gpt-5-mini", "o3"], results: readModelChecks().story ?? [], now: NOW });
  assert.equal(view.state, "expired");
  assert.deepEqual(view.choices, ["gpt-5-mini"]);
  recordModelChecks("story", [pass("o3")], NOW);
  assert.deepEqual(
    readModelChecks().story?.map((result) => result.id),
    ["o3"],
  );
});

test("corrupt or tampered check storage is ignored entry by entry", () => {
  assert.equal(parseModelChecks(null), NO_MODEL_CHECKS);
  assert.equal(parseModelChecks("{nope"), NO_MODEL_CHECKS);
  assert.equal(parseModelChecks("[]"), NO_MODEL_CHECKS);
  assert.equal(parseModelChecks('"text"'), NO_MODEL_CHECKS);
  const parsed = parseModelChecks(
    JSON.stringify({
      story: [
        pass("gpt-5-mini"),
        { id: "bad id", ok: true, ms: 1, checkedAt: NOW },
        { id: "o3", ok: "yes", ms: 1, checkedAt: NOW },
        { id: "o4-mini", ok: false, ms: 1, checkedAt: NOW, reason: "gremlins" },
        { id: "gpt-4.1", ok: true, ms: -1, checkedAt: NOW },
        null,
      ],
      voice: "not a list",
    }),
  );
  assert.deepEqual(parsed, { story: [pass("gpt-5-mini")] });
  const tooMany = Array.from({ length: 500 }, (_, index) => pass(`gpt-${index}`));
  assert.deepEqual(parseModelChecks(JSON.stringify({ story: tooMany })), NO_MODEL_CHECKS);
});

test("storage that throws or is missing keeps results for this tab without breaking", (t) => {
  installStorage(t, () => {
    throw new DOMException("Blocked", "SecurityError");
  });
  assert.equal(readModelChecks(), NO_MODEL_CHECKS);
  assert.equal(recordModelChecks("voice", [pass("gemini-3.5-transcribe")], NOW), false);
  assert.deepEqual(readModelChecks().voice, [pass("gemini-3.5-transcribe")]);

  const failing = new MemoryStorage();
  failing.setItem = () => {
    throw new DOMException("Full", "QuotaExceededError");
  };
  installStorage(t, () => failing);
  assert.equal(recordModelChecks("story", [pass("o3")], NOW), false);
  assert.deepEqual(readModelChecks().story, [pass("o3")]);

  const working = new MemoryStorage();
  installStorage(t, () => working);
  assert.equal(recordModelChecks("story", [pass("gpt-5-mini")], NOW), true);
  assert.ok(working.getItem(MODEL_CHECKS_KEY));
});

// --- Run ---

type Reply = Loaded<ModelTestResponse>;

function fakeTest(replies: Record<string, Reply>, onCall?: (model: string) => void) {
  const calls: string[] = [];
  let active = 0;
  let overlapped = false;
  const test: typeof testModel = async (_kind: ModelKind, model: string) => {
    active += 1;
    if (active > 1) overlapped = true;
    calls.push(model);
    onCall?.(model);
    await Promise.resolve();
    active -= 1;
    return replies[model] ?? { ok: true, value: { ok: true, ms: 500, message: "Works — 0.5 s" } };
  };
  return { calls, test, overlapped: () => overlapped };
}

test("a check run goes one model at a time with a gap, reports progress and saves each result", async (t) => {
  memoryStorage(t);
  const fake = fakeTest({
    "gemini-2.5-flash": { ok: true, value: { ok: false, ms: 200, message: "Busy.", reason: "busy" } },
    "gemini-2.0-flash": { ok: false, error: "The test couldn’t run. Try again." },
  });
  const gaps: number[] = [];
  const progress: string[] = [];
  const run = await checkModels("voice", ["gemini-2.5-flash", "gemini-3.5-transcribe", "gemini-2.0-flash", "gemini-2.5-flash"], {
    signal: new AbortController().signal,
    test: fake.test,
    wait: async (ms) => {
      gaps.push(ms);
    },
    now: () => NOW,
    onProgress: (position, total) => progress.push(`${position}/${total}`),
  });
  assert.deepEqual(fake.calls, ["gemini-2.5-flash", "gemini-3.5-transcribe", "gemini-2.0-flash"]);
  assert.equal(fake.overlapped(), false);
  assert.deepEqual(gaps, [CHECK_GAP_MS, CHECK_GAP_MS]);
  assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
  assert.deepEqual([run.stopped, run.total], [false, 3]);
  assert.deepEqual(
    run.results.map((result) => [result.id, result.ok, result.reason]),
    [
      ["gemini-2.5-flash", false, "busy"],
      ["gemini-3.5-transcribe", true, undefined],
      ["gemini-2.0-flash", false, "unreachable"],
    ],
  );
  assert.equal(readModelChecks().voice?.length, 3);
});

test("a check run is capped and the default goes first", async (t) => {
  memoryStorage(t);
  const listed = Array.from({ length: 45 }, (_, index) => `gpt-5.${index}`);
  const targets = checkTargets("gpt-6.2-sol", listed);
  assert.equal(targets.length, MAX_CHECK_MODELS);
  assert.equal(targets[0], "gpt-6.2-sol");
  assert.deepEqual(checkTargets("o3", ["o3", "o4-mini"]), ["o3", "o4-mini"]);
  const fake = fakeTest({});
  const run = await checkModels("story", ["gpt-6.2-sol", ...listed], {
    signal: new AbortController().signal,
    test: fake.test,
    wait: async () => {},
    now: () => NOW,
  });
  assert.equal(fake.calls.length, MAX_CHECK_MODELS);
  assert.equal(run.total, MAX_CHECK_MODELS);
});

test("stopping a run ends it at once and keeps only the checks that finished", async (t) => {
  memoryStorage(t);
  const controller = new AbortController();
  const fake = fakeTest({}, (model) => {
    if (model === "o3") controller.abort();
  });
  const run = await checkModels("story", ["gpt-5-mini", "o3", "o4-mini"], {
    signal: controller.signal,
    test: fake.test,
    wait: async () => {},
    now: () => NOW,
  });
  assert.equal(run.stopped, true);
  assert.deepEqual(fake.calls, ["gpt-5-mini", "o3"]);
  assert.deepEqual(
    run.results.map((result) => result.id),
    ["gpt-5-mini"],
  );
  assert.deepEqual(
    readModelChecks().story?.map((result) => result.id),
    ["gpt-5-mini"],
  );

  const stoppedDuringGap = new AbortController();
  const second = fakeTest({});
  const gapRun = await checkModels("story", ["gpt-5-mini", "o3"], {
    signal: stoppedDuringGap.signal,
    test: second.test,
    wait: async () => stoppedDuringGap.abort(),
    now: () => NOW,
  });
  assert.equal(gapRun.stopped, true);
  assert.deepEqual(second.calls, ["gpt-5-mini"]);
});

test("the real gap waits between checks and a stop cuts it short", async (t) => {
  memoryStorage(t);
  const controller = new AbortController();
  const fake = fakeTest({}, () => setTimeout(() => controller.abort(), 10));
  const started = Date.now();
  const run = await checkModels("story", ["gpt-5-mini", "o3"], { signal: controller.signal, test: fake.test, now: () => NOW });
  assert.equal(run.stopped, true);
  assert.ok(Date.now() - started < CHECK_GAP_MS, "the abort ends the pause early");
});

test("checkResultFrom keeps the server's reason and treats a route failure as unreachable", () => {
  assert.deepEqual(checkResultFrom("o3", { ok: true, value: { ok: true, ms: 900, message: "Works — 0.9 s" } }, NOW), pass("o3"));
  assert.deepEqual(
    checkResultFrom("o3", { ok: true, value: { ok: false, ms: 20, message: "Limit.", reason: "rate_limit" } }, NOW),
    { id: "o3", ok: false, ms: 20, checkedAt: NOW, reason: "rate_limit" },
  );
  assert.deepEqual(checkResultFrom("o3", { ok: true, value: { ok: false, ms: 20, message: "?" } }, NOW).reason, "unreachable");
  assert.deepEqual(checkResultFrom("o3", { ok: false, error: "offline" }, NOW).reason, "unreachable");
});

// --- What the picker offers ---

test("before any check only the server default is offered", () => {
  const view = modelChoiceView({ defaultId: "gemini-3.5-transcribe", listed: ["gemini-2.5-flash", "gemini-2.5-pro"], results: [], now: NOW });
  assert.equal(view.state, "unchecked");
  assert.deepEqual(view.choices, ["gemini-3.5-transcribe"]);
  assert.equal(checkSummary(view, NOW), null);
  assert.equal(view.failed.length, 0);
});

test("after a check only models that passed are offered, in list order with the default first", () => {
  const results = [fail("gemini-2.5-flash", "not_set_up"), pass("gemini-2.5-pro"), pass("gemini-3.5-transcribe"), fail("gemini-2.0-flash", "no_access")];
  const view = modelChoiceView({
    defaultId: "gemini-3.5-transcribe",
    listed: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
    results,
    now: NOW,
  });
  assert.equal(view.state, "checked");
  assert.deepEqual(view.choices, ["gemini-3.5-transcribe", "gemini-2.5-pro"]);
  assert.deepEqual(view.failed, [
    { id: "gemini-2.0-flash", reason: "no_access" },
    { id: "gemini-2.5-flash", reason: "not_set_up" },
  ]);
  assert.equal(view.defaultStatus, "passed");
  assert.equal(defaultFailedNotice(view, "gemini-3.5-transcribe"), null);
});

test("a saved choice is offered only while its latest check passed", () => {
  const listed = ["gpt-5-mini", "o3"];
  const failed = modelChoiceView({ defaultId: "gpt-6.2-sol", listed, saved: "o3", results: [pass("gpt-6.2-sol"), fail("o3")], now: NOW });
  assert.deepEqual(failed.choices, ["gpt-6.2-sol"]);
  assert.equal(failed.savedStatus, "failed");
  const passed = modelChoiceView({ defaultId: "gpt-6.2-sol", listed, saved: "o3", results: [pass("gpt-6.2-sol"), pass("o3")], now: NOW });
  assert.deepEqual(passed.choices, ["gpt-6.2-sol", "o3"]);
  assert.equal(passed.savedStatus, "passed");
  const unchecked = modelChoiceView({ defaultId: "gpt-6.2-sol", listed, saved: "o3", results: [pass("gpt-6.2-sol")], now: NOW });
  assert.deepEqual(unchecked.choices, ["gpt-6.2-sol"]);
  assert.equal(unchecked.savedStatus, "unchecked");
});

test("models no longer listed don't count, unless the list couldn't load", () => {
  const results = [pass("gpt-6.2-sol"), pass("gpt-retired")];
  const listedView = modelChoiceView({ defaultId: "gpt-6.2-sol", listed: ["o3"], results, now: NOW });
  assert.deepEqual(listedView.choices, ["gpt-6.2-sol"]);
  const offline = modelChoiceView({ defaultId: "gpt-6.2-sol", listed: null, results, now: NOW });
  assert.deepEqual(offline.choices, ["gpt-6.2-sol", "gpt-retired"]);
});

test("a failed default is said plainly with a model that passed, or that none did", () => {
  const view = modelChoiceView({
    defaultId: "gemini-2.5-flash",
    listed: ["gemini-3.5-transcribe", "gemini-2.5-pro"],
    results: [fail("gemini-2.5-flash", "no_access"), pass("gemini-3.5-transcribe"), fail("gemini-2.5-pro", "busy")],
    now: NOW,
  });
  assert.deepEqual(view.choices, ["gemini-3.5-transcribe"]);
  assert.equal(view.suggestion, "gemini-3.5-transcribe");
  assert.equal(
    defaultFailedNotice(view, "gemini-2.5-flash"),
    "The default model (gemini-2.5-flash) didn’t pass its check. Reason: Not available for this key. Try gemini-3.5-transcribe, which passed.",
  );
  const none = modelChoiceView({ defaultId: "gemini-2.5-flash", listed: [], results: [fail("gemini-2.5-flash", "timeout")], now: NOW });
  assert.deepEqual(none.choices, []);
  assert.equal(
    defaultFailedNotice(none, "gemini-2.5-flash"),
    "The default model (gemini-2.5-flash) didn’t pass its check. Reason: Timed out. None of the checked models passed yet.",
  );
});

test("the summary counts what passed and says how long ago", () => {
  const results = [pass("o3", NOW - 2 * MINUTE), fail("o4-mini", "rate_limit", NOW - MINUTE), pass("gpt-6.2-sol", NOW - MINUTE)];
  const view = modelChoiceView({ defaultId: "gpt-6.2-sol", listed: ["o3", "o4-mini"], results, now: NOW });
  assert.equal(checkSummary(view, NOW), "2 of 3 models work with your key · checked 2 min ago");
  const single = modelChoiceView({ defaultId: "gpt-6.2-sol", listed: [], results: [pass("gpt-6.2-sol", NOW)], now: NOW });
  assert.equal(checkSummary(single, NOW + 10_000), "1 of 1 model works with your key · checked just now");
  assert.equal(checkedAgo(59 * MINUTE), "59 min ago");
  assert.equal(checkedAgo(3 * 60 * MINUTE), "3 h ago");
  assert.equal(checkedAgo(24 * 60 * MINUTE), "1 day ago");
  assert.equal(checkedAgo(6 * 24 * 60 * MINUTE), "6 days ago");
  assert.equal(checkedAgo(-5_000), "just now");
});

test("every failure reason has plain words", () => {
  for (const reason of MODEL_CHECK_REASONS) assert.ok(CHECK_REASON_LABELS[reason].length > 3, reason);
  assert.equal(CHECK_REASON_LABELS.busy, "Busy — too much demand right now");
  assert.equal(CHECK_REASON_LABELS.no_access, "Not available for this key");
  assert.equal(CHECK_REASON_LABELS.unsupported, "Can’t do this job");
  assert.equal(CHECK_REASON_LABELS.rate_limit, "Rate limit reached");
  assert.equal(CHECK_REASON_LABELS.timeout, "Timed out");
});

test("a saved choice that fails its check falls back to the default and says so", (t) => {
  memoryStorage(t);
  saveModelPreference("voice", "gemini-2.5-pro");
  assert.equal(dropFailedChoice("voice", [pass("gemini-2.5-pro")], "gemini-3.5-transcribe"), null);
  assert.equal(dropFailedChoice("voice", [fail("gemini-2.0-flash")], "gemini-3.5-transcribe"), null);
  assert.equal(readModelPreferences().voice, "gemini-2.5-pro");
  assert.equal(
    dropFailedChoice("voice", [fail("gemini-2.5-pro", "busy")], "gemini-3.5-transcribe"),
    "Your saved model gemini-2.5-pro failed its check, so new requests use the default (gemini-3.5-transcribe) again. Reason: Busy — too much demand right now.",
  );
  assert.equal(readModelPreferences().voice, undefined);
  assert.equal(dropFailedChoice("voice", [fail("gemini-2.5-pro")], "gemini-3.5-transcribe"), null);
});
