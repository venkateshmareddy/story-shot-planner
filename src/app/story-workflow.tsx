"use client";

import { useCallback, useState } from "react";
import { MAX_ANSWER_CHARACTERS, MAX_FEEDBACK_CHARACTERS, MAX_STORY_CHARACTERS, type StoryMode } from "@/lib/story-input";
import type { PlanningRequest, ShotPlan, StoryDraft } from "@/lib/story-planning";

export function StoryWorkflow({
  initialText, mode, source, onBack,
}: {
  initialText: string;
  mode: StoryMode;
  source: string;
  onBack: (story: string) => void;
}) {
  const [story, setStory] = useState(initialText);
  const [proposal, setProposal] = useState<StoryDraft>();
  const [feedback, setFeedback] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [plan, setPlan] = useState<ShotPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const focusHeading = useCallback((heading: HTMLHeadingElement | null) => {
    heading?.focus();
  }, []);
  const interviewing = questions.length > 0;

  async function requestStep<T>(input: PlanningRequest, receive: (result: T) => void) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/story/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const result: T | { error: string } = await response.json();
      if (!response.ok) {
        setError((result as { error?: string }).error ?? "This step failed. Try again.");
        return;
      }
      receive(result as T);
    } catch {
      setError("This step couldn’t connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (plan) return <PlanPreview plan={plan} onBack={() => setPlan(undefined)} />;

  return (
    <section className="panel" aria-labelledby="workflow-title">
      <h2 id="workflow-title" key={String(interviewing)} tabIndex={-1} ref={focusHeading}>
        {questions.length ? "Creative intent" : mode === "idea" ? "Develop your story" : "Review your story"}
      </h2>
      <fieldset className="workflow" disabled={busy}>
        {questions.length > 0 ? (
          <>
            <p className="muted">Answer the questions that matter to you. Leave any preference open for the planner.</p>
            {questions.map((question, index) => (
              <label className="workflow-field" key={question}>
                {question}
                <textarea
                  rows={2}
                  maxLength={MAX_ANSWER_CHARACTERS}
                  value={answers[index] ?? ""}
                  onChange={(event) => {
                    const answer = event.target.value;
                    setAnswers((previous) => previous.map((value, position) => position === index ? answer : value));
                  }}
                />
              </label>
            ))}
            <div className="workflow-actions">
              <button className="button secondary" type="button" onClick={() => {
                setError("");
                setQuestions([]);
              }}>Back to story</button>
              <button className="button" type="button" onClick={() => void requestStep<ShotPlan>({
                step: "plan", story, answers: questions.map((question, index) => ({
                  question, answer: answers[index] ?? "",
                })),
              }, setPlan)}>Confirm intent and generate shots</button>
            </div>
          </>
        ) : (
          <>
            {source && <p className="muted">Imported from {source}</p>}
            <label className="workflow-field">
              Story text
              <textarea rows={mode === "idea" && !proposal ? 5 : 10} value={story}
                maxLength={MAX_STORY_CHARACTERS} onChange={(event) => {
                  setStory(event.target.value);
                  setProposal(undefined);
                  setError("");
                }} />
            </label>
            {mode === "idea" && (
              <>
                {proposal && (
                  <div>
                    <h3>Suggested draft</h3>
                    <p>{proposal.reason}</p>
                    <div className="story-preview">{proposal.story}</div>
                    <button className="button secondary" type="button" onClick={() => {
                      setStory(proposal.story);
                      setProposal(undefined);
                      setFeedback("");
                    }}>Use this draft</button>
                  </div>
                )}
                <label className="workflow-field">
                  Direction for the draft (optional)
                  <textarea rows={2} value={feedback} maxLength={MAX_FEEDBACK_CHARACTERS}
                    onChange={(event) => setFeedback(event.target.value)} />
                </label>
                <button className="button secondary" type="button" disabled={!story.trim()}
                  onClick={() => void requestStep<StoryDraft>({
                    step: "draft", story: proposal?.story ?? story, feedback,
                  }, setProposal)}>{proposal ? "Request revision" : "Suggest a story draft"}</button>
              </>
            )}
            <div className="workflow-actions">
              <button className="button secondary" type="button" onClick={() => onBack(story)}>Back to intake</button>
              <button className="button" type="button" disabled={!story.trim() || Boolean(proposal)}
                onClick={() => void requestStep<{ questions: string[] }>({ step: "interview", story }, (result) => {
                  setQuestions(result.questions);
                  setAnswers(result.questions.map(() => ""));
                })}>{mode === "idea" ? "Approve story and start interview" : "Start intent interview"}</button>
              {proposal && <button className="button secondary" type="button" onClick={() => {
                setProposal(undefined);
                setFeedback("");
              }}>Discard suggestion</button>}
            </div>
          </>
        )}
      </fieldset>
      {busy && <p role="status">Working on this step…</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function PlanPreview({ plan, onBack }: { plan: ShotPlan; onBack: () => void }) {
  return (
    <section className="panel" aria-labelledby="plan-title">
      <p className="muted">Shot plan draft</p>
      <h2 id="plan-title" tabIndex={-1} ref={(heading) => heading?.focus()}>{plan.title}</h2>
      <p>{plan.logline}</p>
      <p><strong>Creative intent</strong> {plan.intent}</p>
      {plan.reviewNotes.length > 0 && (
        <section>
          <h3>Review notes</h3>
          <ul>{[...new Set(plan.reviewNotes)].map((note) => <li key={note}>{note}</li>)}</ul>
        </section>
      )}
      <details>
        <summary>Characters and locations</summary>
        <ul>
          {plan.characters.map((character) => (
            <li key={`character-${character.name}`}>
              <strong>{character.name}</strong> · {character.role}. {character.look} {character.personality} {character.voice}
            </li>
          ))}
          {plan.locations.map((location) => (
            <li key={`location-${location.name}`}><strong>{location.name}</strong> · {location.description}</li>
          ))}
        </ul>
      </details>
      {plan.scenes.map((scene, sceneIndex) => {
        const sceneId = `S${String(sceneIndex + 1).padStart(2, "0")}`;
        return (
          <section key={sceneId}>
            <h3>{sceneId} · {scene.title}</h3>
            {scene.shots.map((shot, shotIndex) => {
              const shotId = `${sceneId}_SH${String(shotIndex + 1).padStart(2, "0")}`;
              return (
                <details className="shot" key={shotId}>
                  <summary><strong>{shotId}</strong> · {shot.seconds}s · {shot.framing}</summary>
                  <p>{shot.action}</p>
                  <dl>
                    <dt>Camera</dt><dd>{shot.camera}</dd>
                    <dt>Characters</dt><dd>{shot.characters.join(", ") || "None"}</dd>
                    <dt>Location</dt><dd>{shot.location}</dd>
                    <dt>Emotion</dt><dd>{shot.emotion}</dd>
                    <dt>Sound</dt><dd>{shot.sound}</dd>
                    <dt>Dialogue</dt>
                    <dd>{shot.dialogue.length ? shot.dialogue.map((line, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Dialogue is fixed in this preview and can contain repeated lines.
                      <div key={index}>{line.speaker} · {line.line} ({line.delivery})</div>
                    )) : "None"}</dd>
                  </dl>
                </details>
              );
            })}
          </section>
        );
      })}
      <div className="workflow-actions">
        <button className="button secondary" type="button" onClick={onBack}>Back to intent</button>
      </div>
    </section>
  );
}
