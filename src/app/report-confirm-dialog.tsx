"use client";

import { type MouseEvent, type PointerEvent, type Ref, useEffect, useId, useRef, useState } from "react";
import { REPORT_CONFIRM_LABELS as LABELS, type ReportConfirmCopy } from "@/lib/report-confirm";

export type ReportConfirmIds = { title: string; text: string; option: string; note: string };

export type ReportConfirmContentProps = {
  copy: ReportConfirmCopy;
  ids: ReportConfirmIds;
  /** A request is running; Accept waits for it. */
  busy: boolean;
  option: boolean;
  acceptRef?: Ref<HTMLButtonElement>;
  closeRef?: Ref<HTMLButtonElement>;
  onOption: (value: boolean) => void;
  onAccept: (option: boolean) => void;
  onClose: () => void;
};

export function ReportConfirmContent({
  copy,
  ids,
  busy,
  option,
  acceptRef,
  closeRef,
  onOption,
  onAccept,
  onClose,
}: ReportConfirmContentProps) {
  return (
    <div className="report-confirm-body">
      <h2 className="report-confirm-title" id={ids.title}>
        {copy.title}
      </h2>
      <p className="report-confirm-text" id={ids.text}>
        {copy.text}
      </p>
      {copy.option && (
        <div className="report-confirm-option">
          <label className="orig-check" htmlFor={ids.option}>
            <input
              id={ids.option}
              type="checkbox"
              checked={option}
              aria-describedby={ids.note}
              onChange={(event) => onOption(event.target.checked)}
            />
            {copy.option.label}
          </label>
          <p className="muted report-confirm-note" id={ids.note}>
            {copy.option.note}
          </p>
        </div>
      )}
      <p className={busy ? "muted report-confirm-note" : "sr-only"} role="status">
        {busy ? LABELS.busy : ""}
      </p>
      <div className="report-confirm-actions">
        <button ref={closeRef} className="button secondary" type="button" onClick={onClose}>
          {LABELS.close}
        </button>
        <button ref={acceptRef} className="button" type="button" disabled={busy} onClick={() => onAccept(option)}>
          {LABELS.accept}
        </button>
      </div>
    </div>
  );
}

export type ReportConfirmDialogProps = {
  copy: ReportConfirmCopy;
  busy: boolean;
  /** Starting value of the copy's checkbox; unused when the copy has none. */
  option?: boolean;
  onAccept: (option: boolean) => void;
  onClose: () => void;
};

export function ReportConfirmDialog({ copy, busy, option: initialOption = true, onAccept, onClose }: ReportConfirmDialogProps) {
  const id = useId();
  const ids: ReportConfirmIds = { title: `${id}-title`, text: `${id}-text`, option: `${id}-option`, note: `${id}-note` };
  const dialogRef = useRef<HTMLDialogElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const pressedBackdrop = useRef(false);
  const done = useRef(false);
  const [option, setOption] = useState(initialOption);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    (acceptRef.current?.disabled ? closeRef.current : acceptRef.current)?.focus();
  }, []);

  function finish(accepted: boolean, value: boolean) {
    if (done.current) return;
    done.current = true;
    if (dialogRef.current?.open) dialogRef.current.close();
    if (accepted) {
      onAccept(value);
      return;
    }
    if (returnTo.current?.isConnected) returnTo.current.focus();
    onClose();
  }

  function onPointerDown(event: PointerEvent<HTMLDialogElement>) {
    pressedBackdrop.current = event.target === event.currentTarget;
  }

  // The body fills the dialog, so a click that lands on the dialog itself is on the backdrop.
  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (pressedBackdrop.current && event.target === event.currentTarget) finish(false, option);
    pressedBackdrop.current = false;
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only handles the backdrop; Esc closes the native dialog.
    <dialog
      ref={dialogRef}
      className="report-confirm"
      aria-labelledby={ids.title}
      aria-describedby={ids.text}
      onClose={() => finish(false, option)}
      onPointerDown={onPointerDown}
      onClick={onBackdropClick}
    >
      <ReportConfirmContent
        copy={copy}
        ids={ids}
        busy={busy}
        option={option}
        acceptRef={acceptRef}
        closeRef={closeRef}
        onOption={setOption}
        onAccept={(value) => finish(true, value)}
        onClose={() => finish(false, option)}
      />
    </dialog>
  );
}
