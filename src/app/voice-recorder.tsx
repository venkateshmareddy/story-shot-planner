"use client";

import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { formatRecordingTime, MAX_RECORDING_SECONDS, RECORDING_CAP_NOTE } from "@/lib/audio";
import { COMING_SOON_MESSAGE, VOICE_RECORDING_ENABLED } from "@/lib/features";
import { MAX_VOICE_BYTES } from "@/lib/story-input";
import { type RecorderPhase, recordingKeyAction, TRANSCRIBING_TEXT } from "@/lib/voice-ui";
import { VoiceWave } from "./voice-wave";

const formats = [
  { type: "audio/webm;codecs=opus", extension: "webm" },
  { type: "audio/webm", extension: "webm" },
  { type: "audio/mp4", extension: "m4a" },
];

const NOTE_MS = 5_000;

type Timers = { tick?: ReturnType<typeof setInterval>; cap?: ReturnType<typeof setTimeout> };

function releaseMicrophone(stream?: MediaStream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

export type VoiceRecorderOptions = {
  /** A reply is pending: no new recording may start, but one in progress can still be finished or cancelled. */
  busy: boolean;
  onRecording: (file: File) => void;
  onActiveChange: (active: boolean) => void;
};

export type VoiceRecorder = {
  phase: RecorderPhase;
  elapsed: number;
  stream: MediaStream | null;
  error: string;
  note: string;
  start: () => void;
  finish: () => void;
  cancel: () => void;
  clearError: () => void;
  micButton: RefObject<HTMLButtonElement | null>;
  panel: RefObject<HTMLFieldSetElement | null>;
  doneButton: RefObject<HTMLButtonElement | null>;
};

export function useVoiceRecorder({ busy, onRecording, onActiveChange }: VoiceRecorderOptions): VoiceRecorder {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const active = useRef<MediaRecorder | null>(null);
  const keep = useRef(false);
  const timers = useRef<Timers>({});
  const mounted = useRef(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const micButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const refocusMic = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (noteTimer.current) clearTimeout(noteTimer.current);
      clearInterval(timers.current.tick);
      clearTimeout(timers.current.cap);
      const recorder = active.current;
      active.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") recorder.stop();
        releaseMicrophone(recorder.stream);
      }
    };
  }, []);

  useEffect(() => {
    if (phase === "recording") doneButton.current?.focus();
    if (phase === "idle" && refocusMic.current) {
      refocusMic.current = false;
      micButton.current?.focus();
    }
  }, [phase]);

  function showNote(text: string, ms = NOTE_MS) {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(""), ms);
  }

  function clearTimers() {
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.cap);
    timers.current = {};
  }

  async function start() {
    if (!VOICE_RECORDING_ENABLED) {
      showNote(COMING_SOON_MESSAGE, 3_000);
      return;
    }
    if (busy || phase !== "idle") return;
    setError("");
    setNote("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone recording needs a supported browser on HTTPS or localhost. You can still upload audio.");
      return;
    }

    const format = formats.find(({ type }) => MediaRecorder.isTypeSupported(type));
    if (!format) {
      setError("This browser can’t record in a supported format. You can still upload audio.");
      return;
    }

    setPhase("permission");
    onActiveChange(true);
    let microphone: MediaStream | undefined;

    try {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!mounted.current) {
        releaseMicrophone(microphone);
        return;
      }

      const recorder = new MediaRecorder(microphone, { mimeType: format.type, audioBitsPerSecond: 64_000 });
      const chunks: Blob[] = [];
      let size = 0;
      let failure = "";

      recorder.ondataavailable = ({ data }) => {
        if (!data.size || failure) return;
        size += data.size;
        if (size > MAX_VOICE_BYTES) {
          failure = "The recording exceeded 4 MB. Try a shorter voice note.";
          if (recorder.state !== "inactive") recorder.stop();
          return;
        }
        chunks.push(data);
      };

      recorder.onerror = () => {
        failure = "Recording was interrupted. Try again or upload audio.";
      };

      recorder.onstop = () => {
        releaseMicrophone(recorder.stream);
        clearTimers();
        active.current = null;
        setStream(null);
        setPhase("idle");
        onActiveChange(false);
        if (failure) {
          setError(failure);
          return;
        }
        if (!keep.current) return;
        if (!size) {
          setError("The recording was empty. Try again.");
          return;
        }
        onRecording(new File(chunks, `recording.${format.extension}`, { type: recorder.mimeType }));
      };

      active.current = recorder;
      keep.current = false;
      recorder.start(500);
      const startedAt = Date.now();
      setElapsed(0);
      setStream(microphone);
      timers.current.tick = setInterval(() => {
        setElapsed(Math.min(MAX_RECORDING_SECONDS, Math.floor((Date.now() - startedAt) / 1000)));
      }, 250);
      timers.current.cap = setTimeout(() => finish(true), MAX_RECORDING_SECONDS * 1000);
      setPhase("recording");
    } catch (error) {
      releaseMicrophone(microphone);
      active.current = null;
      if (!mounted.current) return;
      setStream(null);
      setPhase("idle");
      onActiveChange(false);
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setError("Microphone access was denied. Allow it in your browser settings or upload audio.");
      } else if (error instanceof DOMException && error.name === "NotFoundError") {
        setError("No microphone was found. Connect one or upload audio.");
      } else {
        setError("The microphone couldn’t start. Check your device or upload audio.");
      }
    }
  }

  function stopRecorder(save: boolean) {
    const recorder = active.current;
    if (recorder?.state !== "recording") return null;
    keep.current = save;
    clearTimers();
    refocusMic.current = Boolean(panel.current?.contains(document.activeElement));
    setPhase("finishing");
    recorder.stop();
    return recorder;
  }

  function finish(capped = false) {
    if (stopRecorder(true) && capped) showNote(RECORDING_CAP_NOTE, NOTE_MS * 2);
  }

  function cancel() {
    const recorder = stopRecorder(false);
    if (!recorder) return;
    releaseMicrophone(recorder.stream);
    showNote("Recording cancelled.");
  }

  return {
    phase,
    elapsed,
    stream,
    error,
    note,
    start: () => void start(),
    finish: () => finish(),
    cancel,
    clearError: () => setError(""),
    micButton,
    panel,
    doneButton,
  };
}

export function MicButton({ recorder, busy }: { recorder: VoiceRecorder; busy: boolean }) {
  if (!VOICE_RECORDING_ENABLED) {
    return (
      <button
        className="icon-btn"
        type="button"
        aria-label="Voice input, coming soon"
        title="Voice input: coming soon"
        onClick={recorder.start}
      >
        <MicIcon />
      </button>
    );
  }
  const live = recorder.phase !== "idle";
  const waiting = busy && !live;
  return (
    <button
      ref={recorder.micButton}
      className={live ? "icon-btn recording" : "icon-btn"}
      type="button"
      aria-label="Record a voice note"
      title={live ? "Recording…" : waiting ? "Wait for the reply before recording" : "Record a voice note"}
      disabled={live || waiting}
      onClick={recorder.start}
    >
      <MicIcon />
    </button>
  );
}

export function RecordingPanel({ recorder }: { recorder: VoiceRecorder }) {
  const finishing = recorder.phase === "finishing";

  function onKeyDown(event: KeyboardEvent<HTMLFieldSetElement>) {
    const action = recordingKeyAction(event.key, event.target instanceof HTMLButtonElement);
    if (!action) return;
    event.preventDefault();
    if (action === "done") recorder.finish();
    else recorder.cancel();
  }

  return (
    <fieldset ref={recorder.panel} className="voice-panel voice-panel-recording" tabIndex={-1} onKeyDown={onKeyDown}>
      <legend className="sr-only">Voice recording</legend>
      <span className="voice-panel-clock">
        <span className="voice-panel-dot" aria-hidden="true">
          ●
        </span>
        <span className="sr-only">Recording </span>
        <span className="voice-panel-time" role="timer">
          {formatRecordingTime(recorder.elapsed)}
        </span>
      </span>
      <VoiceWave stream={recorder.stream} />
      <span className="voice-panel-actions">
        <button
          className="voice-bar-button"
          type="button"
          title="Stop and throw this recording away (Esc)"
          aria-keyshortcuts="Escape"
          disabled={finishing}
          onClick={recorder.cancel}
        >
          <span aria-hidden="true">✕</span> Cancel
        </button>
        <button
          ref={recorder.doneButton}
          className="voice-bar-button voice-bar-done"
          type="button"
          title="Stop and turn your voice into text (Enter)"
          aria-keyshortcuts="Enter"
          disabled={finishing}
          onClick={recorder.finish}
        >
          <span aria-hidden="true">✓</span> Done
        </button>
      </span>
    </fieldset>
  );
}

export function TranscribingPanel() {
  return (
    <div className="voice-panel voice-panel-busy">
      <span className="voice-shimmer" aria-hidden="true">
        <span />
        <span />
      </span>
      <span className="voice-panel-status">
        <span className="voice-spinner" aria-hidden="true" />
        {TRANSCRIBING_TEXT}
      </span>
    </div>
  );
}

export function VoiceProblem({
  message,
  busy,
  onRetry,
  onDismiss,
}: {
  message: string;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="voice-problem">
      <p className="error voice-problem-text" role="alert">
        {message}
      </p>
      <span className="voice-problem-actions">
        <button
          className="voice-bar-button voice-bar-done"
          type="button"
          title={busy ? "Wait for the reply before recording" : "Record your voice note again"}
          disabled={busy}
          onClick={onRetry}
        >
          Try again
        </button>
        <button className="voice-bar-button" type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
