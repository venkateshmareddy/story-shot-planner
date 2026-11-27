"use client";

import { useId } from "react";
import type { StorySession } from "@/lib/session";
import type { ShotPlan } from "@/lib/story-planning";

type PlanEditor = (mutate: (plan: ShotPlan) => void) => void;

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
        <textarea
          id={id}
          className="editor-input"
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="editor-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

export function StoryEditor({
  session,
  onTitleChange,
  onEditPlan,
}: {
  session: StorySession;
  onTitleChange: (title: string) => void;
  onEditPlan: PlanEditor;
}) {
  const { plan } = session;

  return (
    <section className="editor-panel panel" aria-label="Story editor">
      <header className="editor-head">
        <p className="muted studio-eyebrow">Story editor</p>
        <Field label="Project title" value={session.title} onChange={onTitleChange} />
      </header>

      {!plan ? (
        <DiscoveryDocument session={session} />
      ) : (
        <div className="editor-doc" key={`doc-${session.id}`}>
          <Field label="Logline" value={plan.logline} multiline onChange={(v) => onEditPlan((p) => { p.logline = v; })} placeholder="One-sentence summary" />
          <Field label="Creative intent" value={plan.intent} multiline onChange={(v) => onEditPlan((p) => { p.intent = v; })} placeholder="What this film is really about" />

          {plan.reviewNotes.length > 0 && (
            <div className="studio-notes">
              <h3>Review notes</h3>
              <ul>
                {[...new Set(plan.reviewNotes)].map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          <CharacterList plan={plan} onEditPlan={onEditPlan} />
          <LocationList plan={plan} onEditPlan={onEditPlan} />
          <SceneList plan={plan} onEditPlan={onEditPlan} />
        </div>
      )}
    </section>
  );
}

function DiscoveryDocument({ session }: { session: StorySession }) {
  return (
    <div className="editor-doc">
      <p className="muted editor-hint">
        The document fills in as you talk. Answer the creative director’s questions, then generate the shot plan to
        unlock characters, locations, scenes and shots.
      </p>
      {session.collected.length > 0 && (
        <div className="studio-notes">
          <h3>Discovered so far</h3>
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
      )}
    </div>
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

function CharacterList({ plan, onEditPlan }: { plan: ShotPlan; onEditPlan: PlanEditor }) {
  return (
    <section className="editor-section">
      <h3 className="editor-section-head">Characters</h3>
      {plan.characters.length === 0 && <p className="muted">None yet.</p>}
      {plan.characters.map((character, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Characters are edited in place by position.
        <article className="editor-card" key={`character-${index}`}>
          <div className="editor-card-head">
            <strong>{character.name || "Unnamed character"}</strong>
            <RemoveButton
              label={`Remove ${character.name || "character"}`}
              onClick={() => onEditPlan((p) => { p.characters.splice(index, 1); })}
            />
          </div>
          <Field label="Name" value={character.name} onChange={(v) => onEditPlan((p) => { p.characters[index].name = v; })} />
          <Field label="Role" value={character.role} onChange={(v) => onEditPlan((p) => { p.characters[index].role = v; })} />
          <Field label="Look" value={character.look} multiline onChange={(v) => onEditPlan((p) => { p.characters[index].look = v; })} />
          <Field label="Personality" value={character.personality} multiline onChange={(v) => onEditPlan((p) => { p.characters[index].personality = v; })} />
          <Field label="Voice" value={character.voice} multiline onChange={(v) => onEditPlan((p) => { p.characters[index].voice = v; })} />
        </article>
      ))}
      <SectionAdd
        label="Add character"
        onClick={() => onEditPlan((p) => { p.characters.push({ name: "", role: "", look: "", personality: "", voice: "" }); })}
      />
    </section>
  );
}

function LocationList({ plan, onEditPlan }: { plan: ShotPlan; onEditPlan: PlanEditor }) {
  return (
    <section className="editor-section">
      <h3 className="editor-section-head">Locations</h3>
      {plan.locations.length === 0 && <p className="muted">None yet.</p>}
      {plan.locations.map((location, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Locations are edited in place by position.
        <article className="editor-card" key={`location-${index}`}>
          <div className="editor-card-head">
            <strong>{location.name || "Unnamed location"}</strong>
            <RemoveButton
              label={`Remove ${location.name || "location"}`}
              onClick={() => onEditPlan((p) => { p.locations.splice(index, 1); })}
            />
          </div>
          <Field label="Name" value={location.name} onChange={(v) => onEditPlan((p) => { p.locations[index].name = v; })} />
          <Field label="Description" value={location.description} multiline onChange={(v) => onEditPlan((p) => { p.locations[index].description = v; })} />
        </article>
      ))}
      <SectionAdd
        label="Add location"
        onClick={() => onEditPlan((p) => { p.locations.push({ name: "", description: "" }); })}
      />
    </section>
  );
}

function SceneList({ plan, onEditPlan }: { plan: ShotPlan; onEditPlan: PlanEditor }) {
  return (
    <section className="editor-section">
      <h3 className="editor-section-head">Scenes &amp; shots</h3>
      {plan.scenes.length === 0 && <p className="muted">None yet.</p>}
      {plan.scenes.map((scene, sceneIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Scenes are edited in place by position.
        <section className="studio-scene" key={`scene-${sceneIndex}`}>
          <div className="scene-head">
            <span className="scene-id">{sceneId(sceneIndex)}</span>
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
              <article className="shot-card" key={`shot-${sceneIndex}-${shotIndex}`}>
                <div className="editor-card-head">
                  <span className="shot-ref">{shotId(sceneIndex, shotIndex)}</span>
                  <RemoveButton
                    label={`Remove shot ${shotId(sceneIndex, shotIndex)}`}
                    onClick={() => onEditPlan((p) => { p.scenes[sceneIndex].shots.splice(shotIndex, 1); })}
                  />
                </div>
                <Field label="Action" value={shot.action} multiline onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].action = v; })} />
                <div className="editor-row">
                  <Field
                    label="Seconds"
                    value={String(shot.seconds)}
                    onChange={(v) => onEditPlan((p) => {
                      const n = Number.parseFloat(v);
                      p.scenes[sceneIndex].shots[shotIndex].seconds = Number.isFinite(n) && n > 0 ? n : p.scenes[sceneIndex].shots[shotIndex].seconds;
                    })}
                  />
                  <Field label="Framing" value={shot.framing} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].framing = v; })} />
                </div>
                <Field label="Camera" value={shot.camera} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].camera = v; })} />
                <Field
                  label="Characters (comma-separated)"
                  value={shot.characters.join(", ")}
                  onChange={(v) => onEditPlan((p) => {
                    p.scenes[sceneIndex].shots[shotIndex].characters = v.split(",").map((s) => s.trim()).filter(Boolean);
                  })}
                />
                <Field label="Location" value={shot.location} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].location = v; })} />
                <div className="editor-row">
                  <Field label="Emotion" value={shot.emotion} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].emotion = v; })} />
                  <Field label="Sound" value={shot.sound} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].sound = v; })} />
                </div>
                <DialogueList sceneIndex={sceneIndex} shotIndex={shotIndex} lines={shot.dialogue} onEditPlan={onEditPlan} />
              </article>
            ))}
            <SectionAdd
              label="Add shot"
              onClick={() => onEditPlan((p) => {
                p.scenes[sceneIndex].shots.push({
                  seconds: 4,
                  framing: "",
                  camera: "",
                  characters: [],
                  location: "",
                  action: "",
                  dialogue: [],
                  emotion: "",
                  sound: "",
                });
              })}
            />
          </div>
        </section>
      ))}
      <SectionAdd
        label="Add scene"
        onClick={() => onEditPlan((p) => { p.scenes.push({ title: "New scene", shots: [] }); })}
      />
    </section>
  );
}

function DialogueList({
  sceneIndex,
  shotIndex,
  lines,
  onEditPlan,
}: {
  sceneIndex: number;
  shotIndex: number;
  lines: ShotPlan["scenes"][number]["shots"][number]["dialogue"];
  onEditPlan: PlanEditor;
}) {
  return (
    <div className="editor-dialogue">
      <span className="editor-field-label">Dialogue</span>
      {lines.map((line, lineIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Dialogue lines are edited in place by position.
        <div className="editor-dialogue-row" key={`line-${lineIndex}`}>
          <Field label="Speaker" value={line.speaker} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue[lineIndex].speaker = v; })} />
          <Field label="Line" value={line.line} multiline onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue[lineIndex].line = v; })} />
          <Field label="Delivery" value={line.delivery} onChange={(v) => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue[lineIndex].delivery = v; })} />
          <RemoveButton
            label={`Remove dialogue line ${lineIndex + 1}`}
            onClick={() => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue.splice(lineIndex, 1); })}
          />
        </div>
      ))}
      <SectionAdd
        label="Add line"
        onClick={() => onEditPlan((p) => { p.scenes[sceneIndex].shots[shotIndex].dialogue.push({ speaker: "", line: "", delivery: "" }); })}
      />
    </div>
  );
}
