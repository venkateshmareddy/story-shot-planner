import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
  MAX_MODEL_OPTIONS,
  type ModelCatalog,
  type ModelCheckReason,
  type ModelKind,
  type ModelTestResponse,
  modelCatalogSchema,
  modelCheckReasonSchema,
  modelIdSchema,
  modelTestResponseSchema,
  STORY_MODEL_HEADER,
  VOICE_MODEL_HEADER,
} from "@/lib/models";

export const MODEL_PREFERENCES_KEY = "story-studio.modelPreferences.v1";
export const MODEL_CHECKS_KEY = "story-studio.modelChecks.v1";

const storedPreferences = z.object({
  story: modelIdSchema.optional().catch(undefined),
  voice: modelIdSchema.optional().catch(undefined),
});

/** This browser's model choice per job; a missing entry means the server's default. */
export type ModelPreferences = Readonly<Partial<Record<ModelKind, string>>>;

export const NO_MODEL_PREFERENCES: ModelPreferences = Object.freeze({});

const HEADERS: Record<ModelKind, string> = { story: STORY_MODEL_HEADER, voice: VOICE_MODEL_HEADER };

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  try {
    return storage()?.getItem(MODEL_PREFERENCES_KEY) ?? null;
  } catch {
    return null;
  }
}

export function parseModelPreferences(raw: string | null): ModelPreferences {
  if (!raw) return NO_MODEL_PREFERENCES;
  try {
    const parsed = storedPreferences.safeParse(JSON.parse(raw));
    if (!parsed.success) return NO_MODEL_PREFERENCES;
    const { story, voice } = parsed.data;
    return Object.freeze({ ...(story ? { story } : {}), ...(voice ? { voice } : {}) });
  } catch {
    return NO_MODEL_PREFERENCES;
  }
}

let cached: { raw: string | null; value: ModelPreferences } = { raw: null, value: NO_MODEL_PREFERENCES };

/** Stable between calls while storage is unchanged, as useSyncExternalStore requires. */
export function readModelPreferences(): ModelPreferences {
  const raw = readRaw();
  if (raw !== cached.raw) cached = { raw, value: parseModelPreferences(raw) };
  return cached.value;
}

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === MODEL_PREFERENCES_KEY || event.key === MODEL_CHECKS_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** Saves (or, with null, clears) the choice for one job. False when this browser blocks site storage. */
export function saveModelPreference(kind: ModelKind, model: string | null): boolean {
  const next: Partial<Record<ModelKind, string>> = { ...readModelPreferences() };
  if (model === null) delete next[kind];
  else if (modelIdSchema.safeParse(model).success) next[kind] = model;
  else return false;
  try {
    const store = storage();
    if (!store) return false;
    if (Object.keys(next).length) store.setItem(MODEL_PREFERENCES_KEY, JSON.stringify(next));
    else store.removeItem(MODEL_PREFERENCES_KEY);
  } catch {
    return false;
  }
  notify();
  return true;
}

export function useModelPreferences(): ModelPreferences {
  return useSyncExternalStore(subscribe, readModelPreferences, () => NO_MODEL_PREFERENCES);
}

/** Request headers carrying the saved choices; empty when nothing is saved. */
export function modelPreferenceHeaders(preferences: ModelPreferences = readModelPreferences()): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const kind of Object.keys(HEADERS) as ModelKind[]) {
    const model = preferences[kind];
    if (model) headers[HEADERS[kind]] = model;
  }
  return headers;
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

const CATALOG_ERROR = "Couldn’t load the model list. Try Refresh.";
const TEST_ERROR = "The test couldn’t run. Try again.";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = z.object({ error: z.string().max(300) }).safeParse(body);
    return parsed.success ? parsed.data.error : fallback;
  } catch {
    return fallback;
  }
}

/** `refresh` skips the browser's short-lived copy so a changed key or account shows at once. */
export async function fetchModelCatalog({
  refresh = false,
  signal,
}: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Loaded<ModelCatalog>> {
  try {
    const response = await fetch("/api/settings/models", { cache: refresh ? "reload" : "default", signal });
    if (!response.ok) return { ok: false, error: await errorMessage(response, CATALOG_ERROR) };
    const parsed = modelCatalogSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: CATALOG_ERROR };
  } catch {
    return { ok: false, error: CATALOG_ERROR };
  }
}

export async function testModel(
  kind: ModelKind,
  model: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Loaded<ModelTestResponse>> {
  try {
    const response = await fetch("/api/settings/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, model }),
      signal,
    });
    if (!response.ok) return { ok: false, error: await errorMessage(response, TEST_ERROR) };
    const parsed = modelTestResponseSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: TEST_ERROR };
  } catch {
    return { ok: false, error: TEST_ERROR };
  }
}

export const MAX_CHECK_MODELS = 30;
export const CHECK_GAP_MS = 500;
export const CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const modelCheckResultSchema = z.object({
  id: modelIdSchema,
  ok: z.boolean(),
  ms: z.number().int().nonnegative(),
  checkedAt: z.number().int().positive(),
  reason: modelCheckReasonSchema.optional(),
});
export type ModelCheckResult = z.infer<typeof modelCheckResultSchema>;

export type ModelChecks = Readonly<Partial<Record<ModelKind, readonly ModelCheckResult[]>>>;

export const NO_MODEL_CHECKS: ModelChecks = Object.freeze({});

const storedResults = z.array(z.unknown()).max(MAX_MODEL_OPTIONS).optional().catch(undefined);
const storedChecks = z.object({ story: storedResults, voice: storedResults });

function validResults(items: readonly unknown[] | undefined): ModelCheckResult[] {
  const latest = new Map<string, ModelCheckResult>();
  for (const item of items ?? []) {
    const parsed = modelCheckResultSchema.safeParse(item);
    if (!parsed.success) continue;
    const seen = latest.get(parsed.data.id);
    if (!seen || seen.checkedAt <= parsed.data.checkedAt) latest.set(parsed.data.id, parsed.data);
  }
  return [...latest.values()];
}

export function parseModelChecks(raw: string | null): ModelChecks {
  if (!raw) return NO_MODEL_CHECKS;
  try {
    const parsed = storedChecks.safeParse(JSON.parse(raw));
    if (!parsed.success) return NO_MODEL_CHECKS;
    const story = validResults(parsed.data.story);
    const voice = validResults(parsed.data.voice);
    return Object.freeze({ ...(story.length ? { story } : {}), ...(voice.length ? { voice } : {}) });
  } catch {
    return NO_MODEL_CHECKS;
  }
}

// Keeps results for this tab when the browser blocks site storage, so a finished check still shows.
let checksInMemory: string | null = null;

function readChecksRaw(): string | null {
  if (checksInMemory !== null) return checksInMemory;
  try {
    return storage()?.getItem(MODEL_CHECKS_KEY) ?? null;
  } catch {
    return null;
  }
}

let cachedChecks: { raw: string | null; value: ModelChecks } = { raw: null, value: NO_MODEL_CHECKS };

export function readModelChecks(): ModelChecks {
  const raw = readChecksRaw();
  if (raw !== cachedChecks.raw) cachedChecks = { raw, value: parseModelChecks(raw) };
  return cachedChecks.value;
}

export function isFreshCheck(result: Pick<ModelCheckResult, "checkedAt">, now: number): boolean {
  return result.checkedAt <= now + CLOCK_SKEW_MS && now - result.checkedAt < CHECK_TTL_MS;
}

/** Merges new results over this job's fresh ones and drops expired ones. False when only this tab keeps them. */
export function recordModelChecks(kind: ModelKind, results: readonly ModelCheckResult[], now: number = Date.now()): boolean {
  const current = readModelChecks();
  const merged = new Map<string, ModelCheckResult>();
  for (const result of current[kind] ?? []) if (isFreshCheck(result, now)) merged.set(result.id, result);
  for (const result of results) if (modelCheckResultSchema.safeParse(result).success) merged.set(result.id, result);
  const kept = [...merged.values()].sort((a, b) => b.checkedAt - a.checkedAt).slice(0, MAX_MODEL_OPTIONS);
  const raw = JSON.stringify({ ...current, [kind]: kept });
  let stored = false;
  try {
    const store = storage();
    if (store) {
      store.setItem(MODEL_CHECKS_KEY, raw);
      stored = true;
    }
  } catch {}
  checksInMemory = stored ? null : raw;
  notify();
  return stored;
}

export function useModelChecks(): ModelChecks {
  return useSyncExternalStore(subscribe, readModelChecks, () => NO_MODEL_CHECKS);
}

export const CHECK_REASON_LABELS: Record<ModelCheckReason, string> = {
  busy: "Busy — too much demand right now",
  no_access: "Not available for this key",
  unsupported: "Can’t do this job",
  rate_limit: "Rate limit reached",
  timeout: "Timed out",
  unreachable: "Couldn’t be reached",
  not_set_up: "API key not set up",
};

export function checkResultFrom(id: string, loaded: Loaded<ModelTestResponse>, checkedAt: number): ModelCheckResult {
  if (!loaded.ok) return { id, ok: false, ms: 0, checkedAt, reason: "unreachable" };
  const { ok, ms, reason } = loaded.value;
  return ok ? { id, ok, ms, checkedAt } : { id, ok, ms, checkedAt, reason: reason ?? "unreachable" };
}

/** Capped so one run stays short and inside free-tier limits. */
export function checkTargets(defaultId: string, listed: readonly string[]): string[] {
  return [...new Set([defaultId, ...listed])].slice(0, MAX_CHECK_MODELS);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export type CheckRunOptions = {
  signal: AbortSignal;
  onProgress?: (position: number, total: number) => void;
  onResult?: (result: ModelCheckResult) => void;
  test?: typeof testModel;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

export type CheckRun = { results: ModelCheckResult[]; total: number; stopped: boolean };

/** One check at a time with a short gap; each result is saved as it lands, so stopping keeps what finished. */
export async function checkModels(
  kind: ModelKind,
  ids: readonly string[],
  { signal, onProgress, onResult, test = testModel, wait = pause, now = Date.now }: CheckRunOptions,
): Promise<CheckRun> {
  const queue = [...new Set(ids)].slice(0, MAX_CHECK_MODELS);
  const results: ModelCheckResult[] = [];
  const stopped = () => ({ results, total: queue.length, stopped: true });
  for (const [index, id] of queue.entries()) {
    if (index > 0) await wait(CHECK_GAP_MS, signal);
    if (signal.aborted) return stopped();
    onProgress?.(index + 1, queue.length);
    const loaded = await test(kind, id, { signal });
    if (signal.aborted) return stopped();
    const result = checkResultFrom(id, loaded, now());
    results.push(result);
    recordModelChecks(kind, [result], result.checkedAt);
    onResult?.(result);
  }
  return { results, total: queue.length, stopped: false };
}

export type CheckStatus = "passed" | "failed" | "unchecked";

export type ModelChoiceView = {
  state: "unchecked" | "expired" | "checked";
  choices: string[];
  passed: string[];
  failed: { id: string; reason: ModelCheckReason }[];
  checkedAt: number | null;
  defaultStatus: CheckStatus;
  defaultReason: ModelCheckReason | null;
  savedStatus: CheckStatus | "none";
  suggestion: string | null;
};

/** `listed` is null when the provider's list couldn't load; stored results then aren't narrowed to it. */
export function modelChoiceView({
  defaultId,
  listed,
  saved,
  results,
  now,
}: {
  defaultId: string;
  listed: readonly string[] | null;
  saved?: string;
  results: readonly ModelCheckResult[];
  now: number;
}): ModelChoiceView {
  const universe = listed ? new Set([defaultId, ...listed]) : null;
  const known = universe ? results.filter((result) => universe.has(result.id)) : results;
  const fresh = new Map(known.filter((result) => isFreshCheck(result, now)).map((result) => [result.id, result]));
  const state = fresh.size ? "checked" : known.length ? "expired" : "unchecked";
  const order = [...new Set([defaultId, ...(universe ?? []), ...fresh.keys()])];
  const passed = order.filter((id) => fresh.get(id)?.ok === true);
  const failed = order.flatMap((id) => {
    const result = fresh.get(id);
    return result && !result.ok ? [{ id, reason: result.reason ?? "unreachable" }] : [];
  });
  const statusOf = (id: string): CheckStatus => {
    const result = fresh.get(id);
    return result ? (result.ok ? "passed" : "failed") : "unchecked";
  };
  const defaultResult = fresh.get(defaultId);
  const defaultStatus = statusOf(defaultId);
  return {
    state,
    choices: state === "checked" ? passed : [defaultId],
    passed,
    failed,
    checkedAt: fresh.size ? Math.min(...[...fresh.values()].map((result) => result.checkedAt)) : null,
    defaultStatus,
    defaultReason: defaultResult && !defaultResult.ok ? (defaultResult.reason ?? "unreachable") : null,
    savedStatus: saved ? statusOf(saved) : "none",
    suggestion: defaultStatus === "failed" ? (passed[0] ?? null) : null,
  };
}

export function checkedAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function checkSummary(view: ModelChoiceView, now: number): string | null {
  if (view.state !== "checked" || view.checkedAt === null) return null;
  const checked = view.passed.length + view.failed.length;
  const noun = checked === 1 ? "model works" : "models work";
  return `${view.passed.length} of ${checked} ${noun} with your key · checked ${checkedAgo(now - view.checkedAt)}`;
}

export function defaultFailedNotice(view: ModelChoiceView, defaultId: string): string | null {
  if (view.defaultStatus !== "failed") return null;
  const why = CHECK_REASON_LABELS[view.defaultReason ?? "unreachable"];
  const next = view.suggestion ? `Try ${view.suggestion}, which passed.` : "None of the checked models passed yet.";
  return `The default model (${defaultId}) didn’t pass its check. Reason: ${why}. ${next}`;
}

export function dropFailedChoice(kind: ModelKind, results: readonly ModelCheckResult[], defaultId: string): string | null {
  const saved = readModelPreferences()[kind];
  const result = saved ? results.find((entry) => entry.id === saved) : undefined;
  if (!saved || !result || result.ok) return null;
  const why = CHECK_REASON_LABELS[result.reason ?? "unreachable"];
  if (!saveModelPreference(kind, null)) {
    return `Your saved model ${saved} failed its check. Reason: ${why}. Press Use default or pick one that passed.`;
  }
  return `Your saved model ${saved} failed its check, so new requests use the default (${defaultId}) again. Reason: ${why}.`;
}
