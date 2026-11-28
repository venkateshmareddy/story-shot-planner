"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  CHECK_REASON_LABELS,
  CHECK_TTL_MS,
  checkModels,
  checkResultFrom,
  checkSummary,
  checkTargets,
  defaultFailedNotice,
  dropFailedChoice,
  fetchModelCatalog,
  MAX_CHECK_MODELS,
  type ModelCheckResult,
  modelChoiceView,
  recordModelChecks,
  saveModelPreference,
  testModel,
  useModelChecks,
  useModelPreferences,
} from "@/lib/model-preferences";
import type { ModelCatalog, ModelKind, StoryCatalog, VoiceCatalog } from "@/lib/models";

type Feedback = { tone: "ok" | "error"; text: string };

const STORAGE_BLOCKED = "Couldn’t save — this browser is blocking site storage.";
const NO_RESULTS: readonly ModelCheckResult[] = [];
const CLOCK_TICK_MS = 30_000;
const TTL_DAYS = CHECK_TTL_MS / 86_400_000;

export function ModelsSection() {
  const preferences = useModelPreferences();
  const checks = useModelChecks();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    const result = await fetchModelCatalog({ refresh, signal: controller.signal });
    if (controller.signal.aborted) return;
    setLoading(false);
    if (result.ok) setCatalog(result.value);
    else setError(result.error);
  }, []);

  useEffect(() => {
    void load(false);
    return () => request.current?.abort();
  }, [load]);

  return (
    <section className="settings-section-view" aria-labelledby="models-title">
      <header className="settings-section-head">
        <h2 className="studio-title" id="models-title">
          Models
        </h2>
        <p className="muted">
          Choose which AI model does each job. Only models that passed a real check with your API key are offered. Your
          choice and the check results are saved in this browser only. Changing models never changes existing stories.
        </p>
      </header>

      <div className="models-toolbar">
        <button className="button secondary" type="button" onClick={() => void load(true)} disabled={loading}>
          Refresh list
        </button>
        <p className="muted" role="status">
          {loading ? "Loading models…" : ""}
        </p>
      </div>
      {error ? (
        <p className="error models-error" role="alert">
          {error}
        </p>
      ) : null}

      <ModelCard
        kind="story"
        title="Story & planning (Creative Director)"
        entry={catalog?.story ?? null}
        saved={preferences.story}
        results={checks.story ?? NO_RESULTS}
        notes={[
          `Check models sends one tiny request to each model (up to ${MAX_CHECK_MODELS}), one at a time, and uses a few tokens each.`,
          "Costs and limits come from your OpenAI account.",
          "The Token usage page shows which model answered each request.",
        ]}
      />
      <ModelCard
        kind="voice"
        title="Voice-to-text (Gemini)"
        entry={catalog?.voice ?? null}
        saved={preferences.voice}
        results={checks.voice ?? NO_RESULTS}
        notes={[
          `Check models sends a 3-second test recording to each model (up to ${MAX_CHECK_MODELS}), one at a time. A model passes when it writes the recording’s words back correctly.`,
          "On Google’s free tier, Google may use the audio and text you send to improve its products.",
        ]}
      />
    </section>
  );
}

type ModelCardProps = {
  kind: ModelKind;
  title: string;
  entry: StoryCatalog | VoiceCatalog | null;
  saved: string | undefined;
  results: readonly ModelCheckResult[];
  notes: string[];
};

type Progress = { position: number; total: number };

function ModelCard({ kind, title, entry, saved, results, notes }: ModelCardProps) {
  const id = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const test = useRef<AbortController | null>(null);
  const run = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
      test.current?.abort();
      run.current?.abort();
      run.current = null;
    };
  }, []);

  const fallback = entry?.default;
  const notSetUp = entry?.status === "no_key";
  const disabled = !entry || notSetUp;
  const checking = progress !== null;
  const listed = entry?.status === "ok" ? entry.options.map((option) => option.id) : null;
  const view = fallback ? modelChoiceView({ defaultId: fallback, listed, saved, results, now }) : null;
  const choices = view?.choices ?? [];
  const current = saved ?? fallback;
  const selected =
    picked && choices.includes(picked) ? picked : current && choices.includes(current) ? current : (choices[0] ?? "");
  const using = saved ?? (fallback ? `${fallback} (default)` : "the server’s default");
  const summary = view ? checkSummary(view, now) : null;
  const defaultNotice = view && !saved ? defaultFailedNotice(view, fallback ?? "") : null;
  const candidates = fallback ? new Set([fallback, ...(listed ?? [])]).size : 0;
  const targets = fallback ? checkTargets(fallback, listed ?? []) : [];

  const finish = (finished: readonly ModelCheckResult[]) => {
    setNow(Date.now());
    setPicked(null);
    setNotice(fallback ? dropFailedChoice(kind, finished, fallback) : null);
  };

  const runTest = async () => {
    if (!selected) return;
    test.current?.abort();
    const controller = new AbortController();
    test.current = controller;
    setTesting(true);
    setFeedback(null);
    setNotice(null);
    const result = await testModel(kind, selected, { signal: controller.signal });
    if (controller.signal.aborted) return;
    setTesting(false);
    const checked = checkResultFrom(selected, result, Date.now());
    recordModelChecks(kind, [checked], checked.checkedAt);
    finish([checked]);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.error });
      return;
    }
    const { ok, message, usage } = result.value;
    setFeedback({ tone: ok ? "ok" : "error", text: usage ? `${message} · ${usage.totalTokens} tokens` : message });
  };

  const checkAll = async () => {
    if (!targets.length) return;
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setFeedback(null);
    setNotice(null);
    setProgress({ position: 1, total: targets.length });
    const outcome = await checkModels(kind, targets, {
      signal: controller.signal,
      onProgress: (position, total) => setProgress({ position, total }),
      onResult: () => setNow(Date.now()),
    });
    if (run.current !== controller) return;
    run.current = null;
    setProgress(null);
    finish(outcome.results);
    const working = outcome.results.filter((result) => result.ok).length;
    setFeedback({
      tone: "ok",
      text: outcome.stopped
        ? `Stopped after ${outcome.results.length} of ${outcome.total} checks.`
        : `Done — ${working} of ${outcome.total} ${outcome.total === 1 ? "model works" : "models work"} with your key.`,
    });
  };

  const stop = () => run.current?.abort();

  const save = (model: string | null) => {
    const stored = saveModelPreference(kind, model === fallback ? null : model);
    if (!stored) {
      setFeedback({ tone: "error", text: STORAGE_BLOCKED });
      return;
    }
    setPicked(null);
    setNotice(null);
    setFeedback({
      tone: "ok",
      text: model && model !== fallback ? `Saved. New requests in this browser use ${model}.` : "Saved. New requests in this browser use the default.",
    });
  };

  return (
    <section className="settings-card model-card" aria-labelledby={`${id}-title`}>
      <h3 className="editor-section-head" id={`${id}-title`}>
        {title}
      </h3>
      <p id={`${id}-using`}>
        Using: <code>{using}</code>
      </p>

      {entry && entry.status !== "ok" ? (
        <p className={notSetUp ? "model-not-set-up" : "error"} role={notSetUp ? undefined : "alert"}>
          {entry.message}
        </p>
      ) : null}

      {view && !notSetUp ? (
        <div className="model-check">
          <div className="model-check-row">
            {checking ? (
              <button className="button secondary" type="button" onClick={stop}>
                Stop checking
              </button>
            ) : (
              <button className="button secondary" type="button" onClick={() => void checkAll()} disabled={disabled || testing}>
                Check models
              </button>
            )}
            <p className="model-check-progress" role="status">
              {progress ? `Checking ${progress.position} of ${progress.total}…` : ""}
            </p>
          </div>
          <p className="model-check-summary" id={`${id}-summary`}>
            {view.state === "unchecked"
              ? "Not checked yet — press Check models. Until then only the default is offered."
              : view.state === "expired"
                ? `Your last check is more than ${TTL_DAYS} days old — press Check models to check again.`
                : summary}
          </p>
          {candidates > MAX_CHECK_MODELS ? (
            <p className="muted model-note">Check models covers the first {MAX_CHECK_MODELS} models in the list.</p>
          ) : null}
        </div>
      ) : null}

      {defaultNotice ? <p className="model-warning">{defaultNotice}</p> : null}
      {saved && view?.savedStatus === "unchecked" ? (
        <p className="muted">Your saved model ({saved}) hasn’t been checked recently. Press Check models.</p>
      ) : null}
      {saved && view?.savedStatus === "failed" ? (
        <p className="model-warning">Your saved model ({saved}) failed its last check. Press Use default or pick one that passed.</p>
      ) : null}
      <div role="status">{notice ? <p className="model-warning">{notice}</p> : null}</div>

      <label className="editor-field-label" htmlFor={`${id}-select`}>
        Model
      </label>
      <div className="model-controls">
        <select
          id={`${id}-select`}
          className="editor-input model-select"
          value={selected}
          disabled={disabled || choices.length === 0}
          aria-describedby={view && !notSetUp ? `${id}-using ${id}-summary` : `${id}-using`}
          onChange={(event) => {
            setPicked(event.target.value);
            setFeedback(null);
          }}
        >
          {choices.length === 0 ? <option value="">No model passed</option> : null}
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice === fallback ? `${choice} (default)` : choice}
            </option>
          ))}
        </select>
        <button
          className="button secondary"
          type="button"
          onClick={() => void runTest()}
          disabled={disabled || testing || checking || !selected}
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button className="button" type="button" onClick={() => save(selected)} disabled={disabled || !selected || selected === current}>
          Save
        </button>
        <button className="button secondary" type="button" onClick={() => save(null)} disabled={disabled || !saved}>
          Use default
        </button>
      </div>
      <p className={`model-feedback${feedback?.tone === "error" ? " error" : ""}`} role="status">
        {feedback?.text ?? ""}
      </p>

      {view?.failed.length ? (
        <details className="model-failures">
          <summary className="model-failures-toggle">Show models that failed ({view.failed.length})</summary>
          <ul>
            {view.failed.map((failure) => (
              <li key={failure.id}>
                <code>{failure.id}</code> — {CHECK_REASON_LABELS[failure.reason]}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {notes.map((note) => (
        <p className="muted model-note" key={note}>
          {note}
        </p>
      ))}
      <p className="muted model-note">Saving changes only this browser’s choice.</p>
    </section>
  );
}
