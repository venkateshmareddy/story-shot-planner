"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { StorySession } from "@/lib/session";
import type { StorySource } from "@/lib/source-text";
import {
  categoryOf,
  type ContextFact,
  contextReadiness,
  factKey,
  MAX_FACT_VALUE,
  missingCategories,
  type StoryContext,
} from "@/lib/story-context";
import type { ShotPlan } from "@/lib/story-planning";

type PlanEditor = (mutate: (plan: ShotPlan) => void) => void;
type FactAction = (key: string) => void;
type ContextActions = {
  busy: boolean;
  onApproveFact: FactAction;
  onRemoveFact: FactAction;
  onEditFact: (key: string, value: string) => void;
};
type Scene = ShotPlan["scenes"][number];
type Shot = Scene["shots"][number];

function sceneId(index: number) {
  return `S${String(index + 1).padStart(2, "0")}`;
}
function shotId(scene: number, shot: number) {
  return `${sceneId(scene)}_SH${String(shot + 1).padStart(2, "0")}`;
}

function Field({
  label,
  value,
  multiline,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="editor-field">
      <label className="editor-field-label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea id={id} className="editor-input" rows={2} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input id={id} className="editor-input" type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}

function EditToggle({ editing, onClick, label }: { editing: boolean; onClick: () => void; label: string }) {
  return (
    <button className="editor-edit-btn" type="button" aria-pressed={editing} aria-label={label} onClick={onClick}>
      {editing ? "Done" : "Edit"}
    </button>
  );
}

function SectionAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="button secondary editor-add" type="button" onClick={onClick}>
      {label}
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="editor-remove" type="button" aria-label={label} onClick={onClick}>
      Remove
    </button>
  );
}

function SourceLine({ source }: { source: StorySource }) {
  if (source.kind === "suggestion") {
    return <p className="muted editor-source">Starting idea (AI suggestion): {source.name}</p>;
  }
  return (
    <p className="muted editor-source">
      Story source: {source.name} · {source.characters.toLocaleString("en")} characters
      {source.digest ? " · condensed for questions" : ""}
    </p>
  );
}

export function StoryEditor({
  session,
  busy,
  onEditPlan,
  onApproveFact,
  onRemoveFact,
  onEditFact,
}: {
  session: StorySession;
  onEditPlan: PlanEditor;
} & ContextActions) {
  const contextActions: ContextActions = { busy, onApproveFact, onRemoveFact, onEditFact };
  const { plan } = session;
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  // Reset view state when switching projects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the active project id.
  useEffect(() => {
    setEditing(new Set());
    setCollapsed(new Set());
  }, [session.id]);

  const isEditing = (key: string) => editing.has(key);
  const toggleEdit = (key: string) =>
    setEditing((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleCollapse = (index: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  if (!plan) {
    return (
      <section className="editor-panel panel" aria-label="Your story">
        <header className="editor-head editor-doc-head">
          <p className="muted studio-eyebrow">Your story</p>
          <h2 className="studio-title editor-doc-title">{session.title || "Untitled project"}</h2>
          {session.source && <SourceLine source={session.source} />}
        </header>
        <DiscoveryDocument session={session} actions={contextActions} />
      </section>
    );
  }

  const detailsOpen = isEditing("details");
  const shotCount = plan.scenes.reduce((n, scene) => n + scene.shots.length, 0);
  const dialogueCount = plan.scenes.reduce(
    (n, scene) => n + scene.shots.reduce((m, shot) => m + shot.dialogue.length, 0),
    0,
  );
  const totalSeconds = plan.scenes.reduce(
    (n, scene) => n + scene.shots.reduce((m, shot) => m + (Number.isFinite(shot.seconds) && shot.seconds > 0 ? shot.seconds : 0), 0),
    0,
  );

  return (
    <section className="editor-panel panel" aria-label="Your story">
      <header className="editor-head editor-doc-head">
        <p className="muted studio-eyebrow">Shot planner</p>
        <h2 className="studio-title editor-doc-title">{session.title || "Untitled project"}</h2>
        {plan.logline && <p className="editor-logline">{plan.logline}</p>}
        {session.source && <SourceLine source={session.source} />}
        <dl className="bp-stats">
          <div>
            <dd>{plan.scenes.length}</dd>
            <dt>Scenes</dt>
          </div>
          <div>
            <dd>{shotCount}</dd>
            <dt>Shots</dt>
          </div>
          <div>
            <dd>{dialogueCount}</dd>
            <dt>Dialogue lines</dt>
          </div>
          <div>
            <dd>{Math.round(totalSeconds)} s</dd>
            <dt>Running time</dt>
          </div>
          <div>
            <dd>16:9 · 24 fps</dd>
            <dt>Format</dt>
          </div>
        </dl>
      </header>

      <div className="editor-doc" key={`doc-${session.id}`}>
        <div className="editor-section">
          <div className="editor-section-head-row">
            <h3 className="editor-section-head">Overview</h3>
            <EditToggle editing={detailsOpen} label="Edit overview, characters and places" onClick={() => toggleEdit("details")} />
          </div>

          {detailsOpen ? (
            <>
              <Field label="One-line summary" value={plan.logline} multiline placeholder="Describe the film in one sentence" onChange={(v) => onEditPlan((p) => { p.logline = v; })} />
              <Field label="What the film is about" value={plan.intent} multiline placeholder="The feeling or message you want people to take away" onChange={(v) => onEditPlan((p) => { p.intent = v; })} />
              <CharacterEdit plan={plan} onEditPlan={onEditPlan} />
              <LocationEdit plan={plan} onEditPlan={onEditPlan} />
            </>
          ) : (
            <>
              {plan.intent && (
                <div className="studio-intent">
                  <h4 className="editor-subhead">Creator’s intent</h4>
                  <p>{plan.intent}</p>
                </div>
              )}
              <CharacterRead plan={plan} />
              <LocationRead plan={plan} />
            </>
          )}
        </div>

        {plan.reviewNotes.length > 0 && (
          <div className="studio-notes">
            <h3>Things to check</h3>
            <ul>
              {[...new Set(plan.reviewNotes)].map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        {session.context && (session.context.facts.length > 0 || session.context.unresolved.length > 0) && (
          <div className="editor-section">
            <details className="story-details">
              <summary className="editor-section-head">Story details</summary>
              <StoryContextPanel context={session.context} actions={contextActions} />
            </details>
          </div>
        )}

        <div className="editor-section">
          <h3 className="editor-section-head">Scenes &amp; shots</h3>
          {plan.scenes.length === 0 && <p className="muted">None yet.</p>}
          {plan.scenes.map((scene, sceneIndex) => {
            const key = `scene:${sceneIndex}`;
            const open = !collapsed.has(sceneIndex);
            const sceneEditing = isEditing(key);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: Scenes are edited in place by position.
              <section className="studio-scene" key={sceneIndex}>
                <div className="scene-bar">
                  <button
                    className="scene-toggle"
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleCollapse(sceneIndex)}
                  >
                    <span className="scene-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
                    <span className="scene-id">{sceneId(sceneIndex)}</span>
                    <span className="scene-title-read">{scene.title || "Untitled scene"}</span>
                    <span className="muted scene-count">{scene.shots.length} shot{scene.shots.length === 1 ? "" : "s"}</span>
                  </button>
                  <EditToggle editing={sceneEditing} label={`Edit scene ${sceneIndex + 1}`} onClick={() => toggleEdit(key)} />
                </div>

                {open && (sceneEditing ? (
                  <SceneEdit sceneIndex={sceneIndex} scene={scene} onEditPlan={onEditPlan} />
                ) : (
                  <SceneRead scene={scene} sceneIndex={sceneIndex} />
                ))}
              </section>
            );
          })}
          <SectionAdd label="Add scene" onClick={() => onEditPlan((p) => { p.scenes.push({ title: "New scene", shots: [] }); })} />
        </div>
      </div>
    </section>
  );
}

function DiscoveryDocument({ session, actions }: { session: StorySession; actions: ContextActions }) {
  return (
    <div className="editor-doc">
      <p className="muted editor-hint">
        Your story builds up here as you answer. When you’re ready, create the shot plan to see the characters, places,
        scenes and camera shots.
      </p>
      {session.context ? (
        <div className="studio-notes">
          <h3>What we know so far</h3>
          <StoryContextPanel key={session.id} context={session.context} actions={actions} />
        </div>
      ) : (
        session.collected.length > 0 && (
          <div className="studio-notes">
            <h3>What we know so far</h3>
            <dl className="shot-props">
              {session.collected.map((item, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Collected notes are an ordered, append-only summary.
                <div className="editor-collected-row" key={`${item.label}-${index}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        )
      )}
    </div>
  );
}

const PRIORITY_TAGS = { critical: "Must have", high: "Important", medium: "Helpful", optional: "Optional" } as const;

function FactItem({ fact, actions }: { fact: ContextFact; actions: ContextActions }) {
  const key = factKey(fact);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const fieldId = useId();

  useEffect(() => {
    if (editing) fieldRef.current?.focus();
    else if (wasEditing.current) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const trimmed = draft.trim();
  const saveDisabled = actions.busy || !trimmed || trimmed === fact.value.trim();

  function save() {
    if (saveDisabled) return;
    actions.onEditFact(key, trimmed);
    setEditing(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    }
  }

  const heading = (
    <>
      {fact.label}
      <span className="muted context-fact-category"> · {categoryOf(fact.category).label}</span>
    </>
  );

  if (editing) {
    return (
      <li className="context-fact context-fact-editing">
        <label className="context-fact-label" htmlFor={fieldId}>
          {heading}
        </label>
        <textarea
          id={fieldId}
          ref={fieldRef}
          className="editor-input"
          rows={3}
          value={draft}
          maxLength={MAX_FACT_VALUE}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="context-fact-actions">
          <button className="editor-edit-btn" type="button" disabled={saveDisabled} aria-label={`Save: ${fact.label}`} onClick={save}>
            Save
          </button>
          <button className="editor-remove" type="button" aria-label={`Cancel editing: ${fact.label}`} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </span>
      </li>
    );
  }

  return (
    <li className="context-fact">
      <span className="context-fact-label">{heading}</span>
      <span className="context-fact-value">{fact.value}</span>
      <span className="context-fact-actions">
        {fact.source === "ai" && !fact.approved && (
          <button
            className="editor-edit-btn"
            type="button"
            disabled={actions.busy}
            aria-label={`Approve: ${fact.label}`}
            onClick={() => actions.onApproveFact(key)}
          >
            Approve
          </button>
        )}
        <button
          ref={editButtonRef}
          className="editor-edit-btn"
          type="button"
          disabled={actions.busy}
          aria-label={`Edit: ${fact.label}`}
          onClick={() => {
            setDraft(fact.value);
            setEditing(true);
          }}
        >
          Edit
        </button>
        <button
          className="editor-remove"
          type="button"
          disabled={actions.busy}
          aria-label={`Remove: ${fact.label}`}
          onClick={() => actions.onRemoveFact(key)}
        >
          Remove
        </button>
      </span>
    </li>
  );
}

function FactList({ facts, actions }: { facts: ContextFact[]; actions: ContextActions }) {
  return (
    <ul className="context-facts">
      {facts.map((fact, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Keys repeat only if the server sends duplicate facts.
        <FactItem key={`${factKey(fact)}-${index}`} fact={fact} actions={actions} />
      ))}
    </ul>
  );
}

function StoryContextPanel({ context, actions }: { context: StoryContext; actions: ContextActions }) {
  const readiness = contextReadiness(context);
  const missing = missingCategories(context);
  const criticalMissing = missing.filter((category) => category.priority === "critical");
  const fromYou = context.facts.filter((fact) => fact.source === "user");
  const suggestions = context.facts.filter((fact) => fact.source === "ai" && !fact.approved);
  const approved = context.facts.filter((fact) => fact.source === "ai" && fact.approved);
  return (
    <div className="story-context">
      <p className={`context-readiness${readiness.ready ? " context-ready" : ""}`} aria-live="polite">
        {readiness.ready
          ? "Ready to create your plan"
          : `Still needed: ${criticalMissing.map((category) => category.label).join(", ")}`}
      </p>
      {fromYou.length > 0 && (
        <div className="context-group">
          <h4 className="editor-subhead">From you</h4>
          <FactList facts={fromYou} actions={actions} />
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="context-group">
          <h4 className="editor-subhead">AI suggestions</h4>
          <FactList facts={suggestions} actions={actions} />
        </div>
      )}
      {approved.length > 0 && (
        <div className="context-group">
          <h4 className="editor-subhead">Approved</h4>
          <FactList facts={approved} actions={actions} />
        </div>
      )}
      {missing.length > 0 && (
        <div className="context-group">
          <h4 className="editor-subhead">Still missing</h4>
          <ul className="context-missing">
            {missing.slice(0, 6).map((category) => (
              <li key={category.id}>
                {category.label}
                <span className={`context-priority context-priority-${category.priority}`}>
                  {PRIORITY_TAGS[category.priority]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {context.unresolved.length > 0 && (
        <div className="context-group">
          <h4 className="editor-subhead">Open questions</h4>
          <ul className="context-open">
            {context.unresolved.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---------- Read views ---------- */

function CharacterRead({ plan }: { plan: ShotPlan }) {
  return (
    <div className="editor-subsection">
      <h4 className="editor-subhead">Characters</h4>
      {plan.characters.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="bp-table-wrap">
          <table className="bp-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Look</th>
                <th>Personality and voice</th>
              </tr>
            </thead>
            <tbody>
              {plan.characters.map((character, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Characters render in plan order.
                <tr key={index}>
                  <td className="bp-id">{character.name || "—"}</td>
                  <td>{character.role || "—"}</td>
                  <td>{character.look || "—"}</td>
                  <td>{[character.personality, character.voice].filter(Boolean).join(" ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LocationRead({ plan }: { plan: ShotPlan }) {
  return (
    <div className="editor-subsection">
      <h4 className="editor-subhead">Locations</h4>
      {plan.locations.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="bp-table-wrap">
          <table className="bp-table">
            <thead>
              <tr>
                <th>Location</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {plan.locations.map((location, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Locations render in plan order.
                <tr key={index}>
                  <td className="bp-id">{location.name || "—"}</td>
                  <td>{location.description || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SceneRead({ scene, sceneIndex }: { scene: Scene; sceneIndex: number }) {
  if (scene.shots.length === 0) return <p className="muted editor-scene-empty">No shots yet.</p>;
  const places = Array.from(new Set(scene.shots.map((shot) => shot.location.trim()).filter(Boolean))).join(" · ");
  return (
    <>
      {places && <p className="muted bp-scene-sub">{places}</p>}
      <div className="bp-table-wrap">
        <table className="bp-table bp-shots">
          <thead>
            <tr>
              <th>Shot</th>
              <th>Sec</th>
              <th>Framing · Camera</th>
              <th>Who · Location</th>
              <th>What we see</th>
              <th>Dialogue</th>
              <th>Emotion</th>
              <th>Sound</th>
            </tr>
          </thead>
          <tbody>
            {scene.shots.map((shot, shotIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Shots render in scene order.
              <tr key={shotIndex}>
                <td className="bp-id">{shotId(sceneIndex, shotIndex)}</td>
                <td className="bp-num">{shot.seconds}</td>
                <td>
                  {shot.framing || "—"}
                  {shot.camera && <span className="muted bp-sub">{shot.camera}</span>}
                </td>
                <td>
                  {shot.characters.join(", ") || "None"}
                  {shot.location && <span className="muted bp-sub">{shot.location}</span>}
                </td>
                <td>{shot.action || "—"}</td>
                <td>
                  {shot.dialogue.length === 0 ? (
                    "—"
                  ) : (
                    <ul className="bp-dialogue">
                      {shot.dialogue.map((line, lineIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Dialogue lines render in shot order.
                        <li key={lineIndex}>
                          <strong>{line.speaker}</strong> “{line.line}”
                          {line.delivery && <span className="muted"> ({line.delivery})</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{shot.emotion || "—"}</td>
                <td>{shot.sound || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- Edit views ---------- */

function CharacterEdit({ plan, onEditPlan }: { plan: ShotPlan; onEditPlan: PlanEditor }) {
  return (
    <div className="editor-subsection">
      <h4 className="editor-subhead">Characters</h4>
      {plan.characters.map((character, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Characters are edited in place by position.
        <article className="editor-card" key={index}>
          <div className="editor-card-head">
            <strong>{character.name || "Unnamed character"}</strong>
            <RemoveButton label={`Remove ${character.name || "character"}`} onClick={() => onEditPlan((p) => { p.characters.splice(index, 1); })} />
          </div>
          <Field label="Name" value={character.name} onChange={(v) => onEditPlan((p) => { p.characters[index].name = v; })} />
          <Field label="Role" value={character.role} onChange={(v) => onEditPlan((p) => { p.characters[index].role = v; })} />
          <Field label="Look" value={character.look} multiline onChange={(v) => onEditPlan((p) => { p.characters[index].look = v; })} />
          <Field label="Personality" value={character.personality} multiline onChange={(v) => onEditPlan((p) => { p.characters[index].personality = v; })} />
          <Field label="How they speak" value={character.voice} multiline onChange={(v) => onEditPlan((p) => { p.characters[index].voice = v; })} />
        </article>
      ))}
      <SectionAdd label="Add character" onClick={() => onEditPlan((p) => { p.characters.push({ name: "", role: "", look: "", personality: "", voice: "" }); })} />
    </div>
  );
}

function LocationEdit({ plan, onEditPlan }: { plan: ShotPlan; onEditPlan: PlanEditor }) {
  return (
    <div className="editor-subsection">
      <h4 className="editor-subhead">Places</h4>
      {plan.locations.map((location, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Locations are edited in place by position.
        <article className="editor-card" key={index}>
          <div className="editor-card-head">
            <strong>{location.name || "Unnamed place"}</strong>
            <RemoveButton label={`Remove ${location.name || "place"}`} onClick={() => onEditPlan((p) => { p.locations.splice(index, 1); })} />
          </div>
          <Field label="Name" value={location.name} onChange={(v) => onEditPlan((p) => { p.locations[index].name = v; })} />
          <Field label="Description" value={location.description} multiline onChange={(v) => onEditPlan((p) => { p.locations[index].description = v; })} />
        </article>
      ))}
      <SectionAdd label="Add place" onClick={() => onEditPlan((p) => { p.locations.push({ name: "", description: "" }); })} />
    </div>
  );
}

function SceneEdit({
  sceneIndex,
  scene,
  onEditPlan,
}: {
  sceneIndex: number;
  scene: Scene;
  onEditPlan: PlanEditor;
}) {
  return (
    <div className="editor-scene-edit">
      <div className="editor-card-head">
        <input
          className="editor-input editor-scene-title"
          type="text"
          aria-label={`Scene ${sceneIndex + 1} title`}
          value={scene.title}
          onChange={(event) => onEditPlan((p) => { p.scenes[sceneIndex].title = event.target.value; })}
        />
        <RemoveButton label={`Remove scene ${sceneIndex + 1}`} onClick={() => onEditPlan((p) => { p.scenes.splice(sceneIndex, 1); })} />
      </div>
      <div className="shot-grid">
        {scene.shots.map((shot, shotIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Shots are edited in place by position.
          <article className="shot-card" key={shotIndex}>
            <div className="editor-card-head">
              <span className="shot-ref">{shotId(sceneIndex, shotIndex)}</span>
              <RemoveButton label={`Remove shot ${shotId(sceneIndex, shotIndex)}`} onClick={() => onEditPlan((p) => { p.scenes[sceneIndex].shots.splice(shotIndex, 1); })} />
            </div>
            <Field label="What happens" value={shot.action} multiline onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].action = v; })} />
            <div className="editor-row">
              <Field
                label="Length (seconds)"
                value={String(shot.seconds)}
                onChange={(v) => onEditPlan((p) => {
                  const n = Number.parseFloat(v);
                  p.scenes[sceneIndex].shots[shotIndex].seconds = Number.isFinite(n) && n > 0 ? n : p.scenes[sceneIndex].shots[shotIndex].seconds;
                })}
              />
              <Field label="Shot size (how close)" value={shot.framing} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].framing = v; })} />
            </div>
            <Field label="Camera movement" value={shot.camera} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].camera = v; })} />
            <Field
              label="Who’s in it (separate names with commas)"
              value={shot.characters.join(", ")}
              onChange={(v) => onEditPlan((p) => {
                p.scenes[sceneIndex].shots[shotIndex].characters = v.split(",").map((s) => s.trim()).filter(Boolean);
              })}
            />
            <Field label="Place" value={shot.location} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].location = v; })} />
            <div className="editor-row">
              <Field label="Feeling" value={shot.emotion} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].emotion = v; })} />
              <Field label="Sound" value={shot.sound} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].sound = v; })} />
            </div>
            <DialogueEdit sceneIndex={sceneIndex} shotIndex={shotIndex} lines={shot.dialogue} onEditPlan={onEditPlan} />
          </article>
        ))}
        <SectionAdd
          label="Add shot"
          onClick={() => onEditPlan((p) => {
            p.scenes[sceneIndex].shots.push({ seconds: 4, framing: "", camera: "", characters: [], location: "", action: "", dialogue: [], emotion: "", sound: "" });
          })}
        />
      </div>
    </div>
  );
}

function DialogueEdit({
  sceneIndex,
  shotIndex,
  lines,
  onEditPlan,
}: {
  sceneIndex: number;
  shotIndex: number;
  lines: Shot["dialogue"];
  onEditPlan: PlanEditor;
}) {
  return (
    <div className="editor-dialogue">
      <span className="editor-field-label">Dialogue</span>
      {lines.map((line, lineIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Dialogue lines are edited in place by position.
        <div className="editor-dialogue-row" key={lineIndex}>
          <Field label="Who speaks" value={line.speaker} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue[lineIndex].speaker = v; })} />
          <Field label="What they say" value={line.line} multiline onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue[lineIndex].line = v; })} />
          <Field label="How they say it" value={line.delivery} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue[lineIndex].delivery = v; })} />
          <RemoveButton label={`Remove dialogue line ${lineIndex + 1}`} onClick={() => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue.splice(lineIndex, 1); })} />
        </div>
      ))}
      <SectionAdd label="Add line" onClick={() => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue.push({ speaker: "", line: "", delivery: "" }); })} />
    </div>
  );
}
