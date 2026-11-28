"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { StopButton } from "./stop-button";
import {
  type ConceptDigest,
  type IdeaExchange,
  IDEA_DIRECTIONS,
  type IdeasRequest,
  type IdeasResponse,
  MAX_COMBINE,
  type StoryConcept,
  SURPRISE_ME,
} from "@/lib/ideas";
import {
  canCombine,
  type ConceptPlacement,
  IDEA_INPUT_LIMITS,
  ideaDirection,
  placeConcepts,
  rememberShown,
  toggleSelected,
} from "@/lib/ideas-flow";
import { STOPPED_MESSAGE } from "@/lib/request-stop";
import { totalUsage } from "@/lib/session";
import { askIdeas } from "@/lib/studio-agent";
import type { UsageRecord } from "@/lib/usage";

type StoryIdeasProps = {
  onDevelop: (concept: StoryConcept, usage: UsageRecord[]) => void;
  onBack: () => void;
};

type Stage = "opening" | "question" | "concepts";

type IdeasCall = {
  request: IdeasRequest;
  placement: ConceptPlacement;
  status: string;
  /** Draft and selection cleanup that must wait for success, so a failed request keeps the filmmaker's input. */
  onSuccess?: () => void;
};

const CONCEPT_DETAILS = [
  ["mainCharacter", "Main character"],
  ["conflict", "Central conflict"],
  ["emotionalHook", "Emotional hook"],
  ["plotDirection", "Plot direction"],
  ["cinematicAppeal", "Why it works on screen"],
] as const satisfies readonly (readonly [keyof StoryConcept, string])[];

export function StoryIdeas({ onDevelop, onBack }: StoryIdeasProps) {
  const [stage, setStage] = useState<Stage>("opening");
  const [chip, setChip] = useState<string | null>(null);
  const [openingDraft, setOpeningDraft] = useState("");
  const [direction, setDirection] = useState("");
  const [answers, setAnswers] = useState<IdeaExchange[]>([]);
  const [question, setQuestion] = useState<IdeasResponse["question"]>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const [concepts, setConcepts] = useState<StoryConcept[]>([]);
  const [avoid, setAvoid] = useState<ConceptDigest[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [refineId, setRefineId] = useState<string | null>(null);
  const [refineDraft, setRefineDraft] = useState("");
  const [combineNote, setCombineNote] = useState("");
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [lastCall, setLastCall] = useState<IdeasCall | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const pending = status !== "";

  const openingDirection = ideaDirection(chip, openingDraft);
  const directionTooLong = openingDirection.length > IDEA_INPUT_LIMITS.direction;
  const selectedConcepts = concepts.filter((concept) => selected.includes(concept.id));
  const tokens = totalUsage(usage).totalTokens;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: move focus when the step or its question changes.
  useEffect(() => {
    if (stage !== "opening") stageHeadingRef.current?.focus();
  }, [stage, question]);

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(`story-idea-${focusId}`)?.focus();
    setFocusId(null);
  }, [focusId]);

  async function run(call: IdeasCall) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus(call.status);
    setError("");
    setStopped(false);
    setLastCall(call);
    const result = await askIdeas(call.request, { signal: controller.signal });
    controllerRef.current = null;
    pendingRef.current = false;
    setStatus("");
    if (!result.ok) {
      if (result.stopped) setStopped(true);
      else setError(result.error);
      return;
    }
    const { response } = result;
    setUsage((previous) => [...previous, response.usage]);
    setLastCall(null);
    call.onSuccess?.();
    if (response.question) {
      setQuestion(response.question);
      setStage("question");
      return;
    }
    const incoming = call.request.mode === "generate" ? response.concepts : response.concepts.slice(0, 1);
    setConcepts((previous) => placeConcepts(previous, incoming, call.placement));
    setAvoid((previous) => rememberShown(previous, incoming));
    setQuestion(null);
    setStage("concepts");
    if (call.request.mode !== "generate" && incoming[0]) setFocusId(incoming[0].id);
  }

  function startWith(nextDirection: string) {
    if (!nextDirection) return;
    void run({
      request: { mode: "generate", direction: nextDirection, answers: [], avoid: [] },
      placement: { kind: "append" },
      status: "Finding story ideas…",
      onSuccess: () => {
        setDirection(nextDirection);
        setAnswers([]);
      },
    });
  }

  function submitOpening(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!directionTooLong) startWith(openingDirection);
  }

  function answerQuestion(answer: string) {
    const text = answer.trim();
    if (!question || !text) return;
    const nextAnswers = [...answers, { question: question.text, answer: text }];
    void run({
      request: { mode: "generate", direction, answers: nextAnswers, avoid },
      placement: { kind: "append" },
      status: "Finding story ideas…",
      onSuccess: () => {
        setAnswers(nextAnswers);
        setAnswerDraft("");
      },
    });
  }

  function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    answerQuestion(answerDraft);
  }

  function tryDifferent(concept: StoryConcept) {
    void run({
      request: { mode: "another", direction, answers, avoid },
      placement: { kind: "replace", id: concept.id },
      status: "Finding a different idea…",
      onSuccess: () => {
        setSelected((previous) => previous.filter((id) => id !== concept.id));
        if (refineId === concept.id) setRefineId(null);
      },
    });
  }

  function submitRefine(event: FormEvent<HTMLFormElement>, concept: StoryConcept) {
    event.preventDefault();
    const change = refineDraft.trim();
    if (!change) return;
    void run({
      request: { mode: "refine", concept, change },
      placement: { kind: "replace", id: concept.id },
      status: "Reworking this idea…",
      onSuccess: () => {
        setSelected((previous) => previous.filter((id) => id !== concept.id));
        setRefineId(null);
        setRefineDraft("");
      },
    });
  }

  function exploreAnother() {
    void run({
      request: { mode: "another", direction, answers, avoid },
      placement: { kind: "append" },
      status: "Exploring another direction…",
    });
  }

  function combineSelected() {
    if (!canCombine(selectedConcepts.length)) return;
    void run({
      request: { mode: "combine", concepts: selectedConcepts, note: combineNote.trim() },
      placement: { kind: "append" },
      status: "Combining your picks…",
      onSuccess: () => {
        setSelected([]);
        setCombineNote("");
      },
    });
  }

  function toggleRefine(id: string) {
    setRefineId((current) => (current === id ? null : id));
    setRefineDraft("");
  }

  function dismiss(id: string) {
    setConcepts((previous) => previous.filter((concept) => concept.id !== id));
    setSelected((previous) => previous.filter((item) => item !== id));
    if (refineId === id) setRefineId(null);
    stageHeadingRef.current?.focus();
  }

  function retry() {
    if (lastCall) void run(lastCall);
  }

  function stop() {
    controllerRef.current?.abort();
    (stage === "opening" ? titleRef : stageHeadingRef).current?.focus();
  }

  return (
    <section className="new-chat story-ideas" aria-labelledby="story-ideas-title">
      <button className="story-ideas-back" type="button" onClick={onBack}>
        ← Back
      </button>
      <h2 className="studio-title" id="story-ideas-title" ref={titleRef} tabIndex={-1}>
        Story suggestions
      </h2>

      {stage === "opening" && (
        <form className="story-ideas-form" onSubmit={submitOpening}>
          <fieldset className="story-ideas-fieldset">
            <legend className="story-ideas-question">What kind of story would you enjoy making?</legend>
            <div className="quick-actions">
              {IDEA_DIRECTIONS.map((item) => (
                <button
                  key={item}
                  className="quick-action"
                  type="button"
                  aria-pressed={chip === item}
                  disabled={pending}
                  onClick={() => setChip((current) => (current === item ? null : item))}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="editor-field-label" htmlFor="story-ideas-direction">
            {chip ? "Tell us a little more (optional)" : "Or describe it in your own words"}
          </label>
          <textarea
            id="story-ideas-direction"
            className="editor-input"
            rows={2}
            value={openingDraft}
            maxLength={IDEA_INPUT_LIMITS.direction}
            aria-describedby={directionTooLong ? "story-ideas-direction-limit" : undefined}
            placeholder="e.g. a quiet drama about two sisters running a night bakery"
            onChange={(event) => setOpeningDraft(event.target.value)}
          />
          {directionTooLong && (
            <p className="muted story-ideas-hint" id="story-ideas-direction-limit">
              Shorten this to {IDEA_INPUT_LIMITS.direction} characters including the chosen direction.
            </p>
          )}
          <div className="story-ideas-row">
            <button className="button" type="submit" disabled={pending || !openingDirection || directionTooLong}>
              Show me ideas
            </button>
            <button className="button secondary" type="button" disabled={pending} onClick={() => startWith(SURPRISE_ME)}>
              {SURPRISE_ME}
            </button>
          </div>
        </form>
      )}

      {stage === "question" && question && (
        <form className="story-ideas-form" onSubmit={submitAnswer}>
          <h3 className="story-ideas-question" ref={stageHeadingRef} tabIndex={-1}>
            {question.text}
          </h3>
          {question.options.length > 0 && (
            <div className="quick-actions">
              {question.options.map((option) => (
                <button
                  key={option}
                  className="quick-action"
                  type="button"
                  disabled={pending}
                  onClick={() => answerQuestion(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <label className="editor-field-label" htmlFor="story-ideas-answer">
            {question.options.length > 0 ? "Or answer in your own words" : "Your answer"}
          </label>
          <textarea
            id="story-ideas-answer"
            className="editor-input"
            rows={2}
            value={answerDraft}
            maxLength={IDEA_INPUT_LIMITS.answer}
            onChange={(event) => setAnswerDraft(event.target.value)}
          />
          <div className="story-ideas-row">
            <button className="button" type="submit" disabled={pending || !answerDraft.trim()}>
              Continue
            </button>
          </div>
        </form>
      )}

      {stage === "concepts" && (
        <>
          <div className="story-ideas-intro">
            <h3 className="story-ideas-question" ref={stageHeadingRef} tabIndex={-1}>
              Ideas to explore
            </h3>
            <p className="muted">
              Develop one into a project, refine it, or ask for something different. Nothing is saved until you choose
              “Develop this idea”.
            </p>
          </div>

          {concepts.length === 0 ? (
            <p className="muted">No ideas left here. Explore another direction for a fresh one.</p>
          ) : (
            <ul className="story-ideas-grid">
              {concepts.map((concept) => {
                const titleId = `story-idea-${concept.id}`;
                const isSelected = selected.includes(concept.id);
                const refining = refineId === concept.id;
                return (
                  <li key={concept.id} className={`story-idea-card${isSelected ? " is-selected" : ""}`}>
                    <article aria-labelledby={titleId}>
                      {concept.genre && <p className="story-idea-genre">{concept.genre}</p>}
                      <h4 className="story-idea-title" id={titleId} tabIndex={-1}>
                        {concept.title}
                      </h4>
                      <p className="story-idea-premise">{concept.premise}</p>
                      <dl className="story-idea-details">
                        {CONCEPT_DETAILS.filter(([field]) => concept[field]).map(([field, label]) => (
                          <div key={field}>
                            <dt>{label}</dt>
                            <dd>{concept[field]}</dd>
                          </div>
                        ))}
                      </dl>
                      <div className="story-idea-actions">
                        <button
                          className="button"
                          type="button"
                          aria-describedby={titleId}
                          disabled={pending}
                          onClick={() => onDevelop(concept, usage)}
                        >
                          Develop this idea
                        </button>
                        <button
                          className="button secondary"
                          type="button"
                          aria-describedby={titleId}
                          aria-expanded={refining}
                          disabled={pending}
                          onClick={() => toggleRefine(concept.id)}
                        >
                          Refine
                        </button>
                        <button
                          className="button secondary"
                          type="button"
                          aria-describedby={titleId}
                          disabled={pending}
                          onClick={() => tryDifferent(concept)}
                        >
                          Try a different one
                        </button>
                      </div>
                      {refining && (
                        <form className="story-idea-refine" onSubmit={(event) => submitRefine(event, concept)}>
                          <label className="editor-field-label" htmlFor={`${titleId}-change`}>
                            What would you change?
                          </label>
                          <textarea
                            id={`${titleId}-change`}
                            className="editor-input"
                            rows={2}
                            value={refineDraft}
                            maxLength={IDEA_INPUT_LIMITS.change}
                            placeholder="e.g. make it funnier, set it in a small town"
                            onChange={(event) => setRefineDraft(event.target.value)}
                          />
                          <div className="story-ideas-row">
                            <button className="button" type="submit" disabled={pending || !refineDraft.trim()}>
                              Refine idea
                            </button>
                            <button
                              className="button secondary"
                              type="button"
                              disabled={pending}
                              onClick={() => toggleRefine(concept.id)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                      <div className="story-idea-foot">
                        <label className="story-idea-select">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            aria-describedby={titleId}
                            disabled={pending || (!isSelected && selected.length >= MAX_COMBINE)}
                            onChange={() => setSelected((previous) => toggleSelected(previous, concept.id))}
                          />
                          Select to combine
                        </label>
                        <button
                          className="story-idea-dismiss"
                          type="button"
                          aria-describedby={titleId}
                          disabled={pending}
                          onClick={() => dismiss(concept.id)}
                        >
                          Not for me
                        </button>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="story-ideas-global">
            <button className="button secondary" type="button" disabled={pending} onClick={exploreAnother}>
              Explore another direction
            </button>
            <div className="story-ideas-combine">
              <label className="editor-field-label" htmlFor="story-ideas-combine-note">
                Combine note (optional)
              </label>
              <div className="story-ideas-row">
                <input
                  id="story-ideas-combine-note"
                  className="editor-input"
                  type="text"
                  value={combineNote}
                  maxLength={IDEA_INPUT_LIMITS.note}
                  placeholder="e.g. keep the setting of the first one"
                  onChange={(event) => setCombineNote(event.target.value)}
                />
                <button
                  className="button secondary"
                  type="button"
                  disabled={pending || !canCombine(selectedConcepts.length)}
                  onClick={combineSelected}
                >
                  Combine selected ({selectedConcepts.length})
                </button>
              </div>
              <p className="muted story-ideas-hint">Select 2–{MAX_COMBINE} ideas to blend them into one.</p>
            </div>
          </div>
        </>
      )}

      <div className="stop-row">
        <p className="muted story-ideas-status" role="status">
          {status || (stopped ? STOPPED_MESSAGE : "")}
        </p>
        {pending && <StopButton onStop={stop} />}
      </div>
      {error && (
        <div className="story-ideas-error" role="alert">
          <p className="error">{error}</p>
          {lastCall && (
            <button className="button secondary" type="button" disabled={pending} onClick={retry}>
              Retry
            </button>
          )}
        </div>
      )}
      {tokens > 0 && <p className="muted story-ideas-usage">{tokens.toLocaleString("en")} tokens used</p>}
    </section>
  );
}
