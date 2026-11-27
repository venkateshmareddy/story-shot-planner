"use client";

import { Fragment, type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { buildBlueprint, canExportFinal } from "@/lib/blueprint";
import type { StorySession } from "@/lib/session";
import styles from "./export-menu.module.css";

type ExportFormat = "pdf" | "docx";
type ExportOption = { label: string; final: boolean; format: ExportFormat };

const OPTIONS: ExportOption[] = [
  { label: "Draft PDF", final: false, format: "pdf" },
  { label: "Draft Word (.docx)", final: false, format: "docx" },
  { label: "Final PDF", final: true, format: "pdf" },
  { label: "Final Word (.docx)", final: true, format: "docx" },
];

const CONFIRM_FINAL = "Export the final blueprint? It will be marked FINAL with today's date.";
const MIME: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export type ExportMenuProps = { session: StorySession };

function slug(title: string): string {
  const value = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return value || "project";
}

async function renderFile(session: StorySession, option: ExportOption): Promise<{ blob: Blob; filename: string }> {
  const blueprint = buildBlueprint(session, { final: option.final, date: new Date() });
  const filename = `${slug(blueprint.title)}-blueprint-${option.final ? "final" : "draft"}.${option.format}`;
  if (option.format === "pdf") {
    const { blueprintToPdf } = await import("@/lib/export/pdf");
    const bytes = await blueprintToPdf(blueprint);
    return { blob: new Blob([new Uint8Array(bytes)], { type: MIME.pdf }), filename };
  }
  const { blueprintToDocx, toDocxBlob } = await import("@/lib/export/docx");
  const blob = await toDocxBlob(blueprintToDocx(blueprint));
  return { blob: blob.type ? blob : new Blob([blob], { type: MIME.docx }), filename };
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in Firefox and Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportMenu({ session }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const hintId = useId();
  const finalReady = canExportFinal(session);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      event.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : event.key === "ArrowUp"
          ? items[(index - 1 + items.length) % items.length]
          : event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items[items.length - 1]
              : null;
    if (target) {
      event.preventDefault();
      target.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  const runExport = async (option: ExportOption) => {
    if (busy) return;
    if (option.final && (!finalReady || !window.confirm(CONFIRM_FINAL))) return;
    close(true);
    setError(null);
    setBusy(`Preparing ${option.label}…`);
    try {
      const { blob, filename } = await renderFile(session, option);
      download(blob, filename);
    } catch {
      setError(`Couldn't create the ${option.label} file. Please try again.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`button secondary ${styles.trigger}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Export the filmmaking blueprint"
        disabled={busy !== null}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {busy ? "Exporting…" : "Export"}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Export options"
          className={styles.menu}
          onKeyDown={onMenuKeyDown}
        >
          {OPTIONS.map((option, index) => (
            <Fragment key={option.label}>
              {index > 0 && option.final !== OPTIONS[index - 1].final && <hr className={styles.separator} />}
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                disabled={option.final && !finalReady}
                aria-describedby={option.final && !finalReady ? hintId : undefined}
                onClick={() => void runExport(option)}
              >
                {option.label}
              </button>
            </Fragment>
          ))}
          {!finalReady && (
            <p id={hintId} className={styles.hint}>
              Final export unlocks once the shot plan has at least one shot. Drafts work at any stage.
            </p>
          )}
        </div>
      )}
      <p role="status" className={styles.status}>
        {busy ?? ""}
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
