"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { StoryWorkflow } from "./story-workflow";
import { VoicePlayback, VoiceRecorder } from "./voice-recorder";
import {
  BYTES_PER_MB,
  MAX_STORY_CHARACTERS,
  MAX_UPLOAD_MB,
  MAX_VOICE_BYTES,
  type StoryImportResult,
  type StoryMode,
} from "@/lib/story-input";

const modes = [
  { id: "idea", title: "Start with an idea", description: "Bring a premise to develop into a story." },
  { id: "finished", title: "Use a finished story", description: "Paste a story or import a document." },
] as const;

export function StoryIntake() {
  const [mode, setMode] = useState<StoryMode>("idea");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<"file" | "voice">();
  const [reviewing, setReviewing] = useState(false);
  const [voiceNote, setVoiceNote] = useState<File>();
  const [capturingVoice, setCapturingVoice] = useState(false);
  const voiceInput = useRef<HTMLInputElement>(null);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setError("");
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "txt" && extension !== "pdf") {
      setError("Choose a TXT or PDF file.");
      return;
    }

    const limit = MAX_UPLOAD_MB[extension];
    if (file.size > limit * BYTES_PER_MB) {
      setError(`Choose a file that is ${limit} MB or smaller.`);
      return;
    }

    setImporting("file");
    try {
      let imported: string;
      if (extension === "pdf") {
        const response = await fetch("/api/story/import", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: file,
        });
        const result: StoryImportResult = await response.json();
        if ("error" in result) {
          setError(result.error);
          return;
        }
        if (!response.ok) throw new Error("PDF import failed");
        imported = result.text;
      } else {
        imported = await file.text();
      }

      if (!imported.trim()) {
        setError("This file is empty. Choose another file or paste your text.");
      } else if (imported.length > MAX_STORY_CHARACTERS) {
        setError("This story is too long. Import a shorter excerpt.");
      } else {
        setText(imported);
        setSource(file.name);
      }
    } catch {
      setError("The file couldn’t be imported. Try again or paste your text.");
    } finally {
      setImporting(undefined);
    }
  }

  async function transcribeVoiceNote() {
    if (!voiceNote) return;
    if (voiceNote.size > MAX_VOICE_BYTES) {
      setError("Choose a voice note that’s 4 MB or smaller.");
      return;
    }
    setImporting("voice");
    setError("");
    try {
      const response = await fetch("/api/story/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Audio-Extension": voiceNote.name.split(".").pop()?.toLowerCase() ?? "",
        },
        body: voiceNote,
      });
      const result: StoryImportResult = await response.json();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      if (!response.ok) throw new Error("Transcription failed");
      setText(result.text);
      setSource(voiceNote.name);
      setVoiceNote(undefined);
      if (voiceInput.current) voiceInput.current.value = "";
    } catch {
      setError("The voice note couldn’t be transcribed. Try again or paste the text.");
    } finally {
      setImporting(undefined);
    }
  }

  function reviewStory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importing || capturingVoice) return;
    if (!text.trim()) {
      setError(mode === "idea" ? "Enter a story idea." : "Enter or import a story.");
      return;
    }
    setError("");
    setReviewing(true);
  }

  if (reviewing) {
    return (
      <StoryWorkflow initialText={text} mode={mode} source={source} onBack={(story) => {
        setText(story);
        setReviewing(false);
      }} />
    );
  }

  return (
    <form className="panel" onSubmit={reviewStory}>
      <fieldset disabled={Boolean(importing)}>
        <legend>How are you starting?</legend>
        <div className="mode-grid">
          {modes.map((option) => (
            <label className="mode" key={option.id}>
              <input
                type="radio"
                name="story-mode"
                value={option.id}
                checked={mode === option.id}
                onChange={() => {
                  setMode(option.id);
                  setError("");
                }}
              />
              <span>
                <strong>{option.title}</strong>
                <span className="mode-description">{option.description}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="text-label" htmlFor="story-text">
          {mode === "idea" ? "Story idea" : "Story text"}
        </label>
        <textarea
          id="story-text"
          value={text}
          maxLength={MAX_STORY_CHARACTERS}
          rows={mode === "idea" ? 4 : 8}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
        />

        <div className="form-footer">
          <div>
            <label className="upload-label" htmlFor="story-file">
              Import TXT or PDF
            </label>
            <input
              id="story-file"
              className="file-input"
              type="file"
              accept=".txt,.pdf,text/plain,application/pdf"
              disabled={capturingVoice}
              onChange={importFile}
            />
            <span className="muted" role="status">
              {importing === "file"
                ? "Reading file…"
                : source
                  ? `Imported from ${source}`
                  : `Up to ${MAX_UPLOAD_MB.txt} MB for TXT or ${MAX_UPLOAD_MB.pdf} MB for PDF`}
            </span>
          </div>
          <button className="button" type="submit" disabled={capturingVoice}>Review story</button>
        </div>
        <section className="voice-import" aria-labelledby="voice-note-title">
          <h3 id="voice-note-title">Voice note</h3>
          <VoiceRecorder
            onActiveChange={setCapturingVoice}
            onRecording={(recording) => {
              setVoiceNote(recording);
              setError("");
              if (voiceInput.current) voiceInput.current.value = "";
            }}
          />
          <label className="upload-label" htmlFor="voice-note">Or upload audio up to 4 MB</label>
          <input id="voice-note" className="file-input" type="file" accept=".mp3,.wav,.m4a,.webm" ref={voiceInput}
            disabled={capturingVoice}
            onChange={(event) => {
              setVoiceNote(event.currentTarget.files?.[0]);
              setError("");
            }} />
          {voiceNote && (
            <div className="voice-selection">
              <p className="muted">{voiceNote.name}</p>
              <VoicePlayback file={voiceNote} />
              <button className="button secondary" type="button" disabled={capturingVoice}
                onClick={() => void transcribeVoiceNote()}>Transcribe voice note</button>
              <button className="button secondary" type="button" disabled={capturingVoice} onClick={() => {
                setVoiceNote(undefined);
                setError("");
                if (voiceInput.current) voiceInput.current.value = "";
              }}>Discard voice note</button>
            </div>
          )}
          {importing === "voice" && <p role="status" className="muted">Transcribing voice note…</p>}
        </section>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
