"use client";

import { STORY_MODEL, TRANSCRIPTION_MODEL } from "@/lib/models";
import { totalUsage, type StorySession } from "@/lib/session";

const numberFormat = new Intl.NumberFormat();
const format = (value: number) => numberFormat.format(value);

export function UsageView({ sessions, budget }: { sessions: StorySession[]; budget: number }) {
  const allRecords = sessions.flatMap((session) => session.usage);
  const totals = totalUsage(allRecords);
  const usedModels = Array.from(new Set(allRecords.map((record) => record.model).filter(Boolean)));
  const models = usedModels.length > 0 ? usedModels : [STORY_MODEL, TRANSCRIPTION_MODEL];

  return (
    <section className="settings-section-view" aria-labelledby="usage-view-title">
      <header className="settings-section-head usage-section-head">
        <div>
          <h2 className="studio-title" id="usage-view-title">
            Model &amp; token usage
          </h2>
          <p className="muted">Token counts reported by the model API, summed across your sessions.</p>
        </div>
        <span className="usage-models">
          {models.map((model, index) => (
            <span key={model}>
              {index > 0 && " · "}
              <code>{model}</code>
            </span>
          ))}
        </span>
      </header>

      <dl className="usage-totals">
        <div>
          <dt>Requests</dt>
          <dd>{format(allRecords.length)}</dd>
        </div>
        <div>
          <dt>Input tokens</dt>
          <dd>{format(totals.inputTokens)}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{format(totals.outputTokens)}</dd>
        </div>
        <div className="usage-total">
          <dt>Total tokens</dt>
          <dd>{format(totals.totalTokens)}</dd>
        </div>
      </dl>

      <BudgetMeter used={totals.totalTokens} budget={budget} />

      <h3 className="editor-section-head usage-by-session">Usage by session</h3>
      {sessions.length === 0 ? (
        <p className="muted">No sessions yet. Totals update after each AI step.</p>
      ) : (
        <div className="usage-log">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col" className="usage-num">Requests</th>
                <th scope="col" className="usage-num">In</th>
                <th scope="col" className="usage-num">Out</th>
                <th scope="col" className="usage-num">Total</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const perSession = totalUsage(session.usage);
                return (
                  <tr key={session.id}>
                    <td>{session.title}</td>
                    <td className="usage-num">{format(session.usage.length)}</td>
                    <td className="usage-num">{format(perSession.inputTokens)}</td>
                    <td className="usage-num">{format(perSession.outputTokens)}</td>
                    <td className="usage-num">{format(perSession.totalTokens)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted usage-note">
        Token counts are reported by the model API per request and summed in this browser. They reset if you clear local
        data.
      </p>
    </section>
  );
}

function BudgetMeter({ used, budget }: { used: number; budget: number }) {
  if (budget <= 0) {
    return (
      <p className="muted budget-empty">
        No token budget set. Set a soft limit in <strong>Settings</strong> to track progress here.
      </p>
    );
  }

  const ratio = used / budget;
  const over = ratio >= 1;
  const warn = ratio >= 0.75 && ratio < 1;
  const percent = Math.round(ratio * 100);
  const fillClass = over ? "budget-fill budget-over" : warn ? "budget-fill budget-warn" : "budget-fill";

  return (
    <div className="budget-meter">
      <div className="budget-meter-head">
        <span className="editor-section-head">Token budget</span>
        <span className="budget-meter-figure">
          {format(used)} / {format(budget)} · {percent}%
        </span>
      </div>
      <div
        className="budget-track"
        role="progressbar"
        aria-label="Total tokens used against budget"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={Math.min(used, budget)}
      >
        <div className={fillClass} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
      </div>
      {over ? (
        <p className="budget-note budget-note-over">Over budget by {format(used - budget)} tokens.</p>
      ) : warn ? (
        <p className="budget-note budget-note-warn">Approaching the budget — {format(budget - used)} tokens left.</p>
      ) : null}
    </div>
  );
}
