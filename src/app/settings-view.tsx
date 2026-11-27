"use client";

import { enabledFormats, FORMAT_REGISTRY, getFormatProfile } from "@/lib/formats";
import { STORY_MODEL, TRANSCRIPTION_MODEL } from "@/lib/models";

export function PreferencesSection({
  budget,
  onBudgetChange,
}: {
  budget: number;
  onBudgetChange: (value: number) => void;
}) {
  const active = getFormatProfile(enabledFormats()[0]);

  return (
    <section className="settings-section-view" aria-labelledby="preferences-title">
      <header className="settings-section-head">
        <h2 className="studio-title" id="preferences-title">
          Preferences
        </h2>
        <p className="muted">Settings that change how the studio plans and tracks your projects.</p>
      </header>

      <div className="settings-card">
        <h3 className="editor-section-head">Token budget</h3>
        <p className="muted">
          A soft limit for total tokens across all sessions. The Token usage page shows progress toward it and warns as
          you get close. Set 0 for no limit.
        </p>
        <label className="editor-field-label" htmlFor="token-budget">
          Budget (tokens)
        </label>
        <input
          id="token-budget"
          className="editor-input settings-input"
          type="number"
          min={0}
          step={1000}
          value={budget}
          onChange={(event) => onBudgetChange(Number.parseInt(event.target.value, 10) || 0)}
        />
      </div>

      <div className="settings-card">
        <h3 className="editor-section-head">Format (Phase 1)</h3>
        <p>
          <strong>{active.label}</strong> — {active.tagline}
        </p>
        <p className="muted">
          Only the short-film format is enabled in this phase. Other formats are defined but not yet available:{" "}
          {Object.values(FORMAT_REGISTRY)
            .filter((profile) => !profile.enabled)
            .map((profile) => profile.label)
            .join(", ")}
          .
        </p>
      </div>

      <div className="settings-card">
        <h3 className="editor-section-head">Models</h3>
        <p className="muted">
          Planning &amp; refinement: <code>{STORY_MODEL}</code>
          <br />
          Voice transcription: <code>{TRANSCRIPTION_MODEL}</code>
        </p>
        <p className="muted">
          The API key is configured on the server and is never exposed to the browser. There is nothing to configure
          here.
        </p>
      </div>
    </section>
  );
}

export function DataSection({ sessionCount, onClearAll }: { sessionCount: number; onClearAll: () => void }) {
  return (
    <section className="settings-section-view" aria-labelledby="data-title">
      <header className="settings-section-head">
        <h2 className="studio-title" id="data-title">
          Data &amp; privacy
        </h2>
        <p className="muted">Manage the projects stored for this app.</p>
      </header>

      <div className="settings-card">
        <h3 className="editor-section-head">Stored projects</h3>
        <p className="muted">
          You currently have <strong>{sessionCount}</strong> session(s). Deleting them removes their conversations,
          story documents and usage history.
        </p>
        <button
          className="button secondary"
          type="button"
          disabled={sessionCount === 0}
          onClick={() => {
            if (window.confirm(`Delete all ${sessionCount} session(s)? This cannot be undone.`)) {
              onClearAll();
            }
          }}
        >
          Delete all sessions
        </button>
      </div>
    </section>
  );
}
