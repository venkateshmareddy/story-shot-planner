"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import {
  BYTES_PER_MB,
  MAX_STORY_CHARACTERS,
  MAX_UPLOAD_MB,
  type PdfImportResult,
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
  const [importing, setImporting] = useState(false);
  const [reviewing, setReviewing] = useState(false);

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

    setImporting(true);
    try {
      let imported: string;
      if (extension === "pdf") {
        const response = await fetch("/api/story/import", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: file,
        });
        const result: PdfImportResult = await response.json();
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
      setImporting(false);
    }
  }

  function reviewStory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) {
      setError(mode === "idea" ? "Enter a story idea." : "Enter or import a story.");
      return;
    }
    setError("");
    setReviewing(true);
  }

  if (reviewing) {
    return (
      <section className="panel" aria-labelledby="review-title">
        <h2 id="review-title" tabIndex={-1} ref={(heading) => heading?.focus()}>
          {mode === "idea" ? "Review your idea" : "Review your story"}
        </h2>
        {source && <p className="muted">Imported from {source}</p>}
        <div className="story-preview">{text}</div>
        <button className="button secondary" type="button" onClick={() => setReviewing(false)}>
          Back to editor
        </button>
      </section>
    );
  }

  return (
    <form className="panel" onSubmit={reviewStory}>
      <fieldset disabled={importing}>
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
              onChange={importFile}
            />
            <span className="muted" role="status">
              {importing
                ? "Reading file…"
                : source
                  ? `Imported from ${source}`
                  : `Up to ${MAX_UPLOAD_MB.txt} MB for TXT or ${MAX_UPLOAD_MB.pdf} MB for PDF`}
            </span>
          </div>
          <button className="button" type="submit">Review story</button>
        </div>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
