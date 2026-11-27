"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_VOICE_BYTES } from "@/lib/story-input";

const formats = [
  { type: "audio/webm;codecs=opus", extension: "webm" },
  { type: "audio/webm", extension: "webm" },
  { type: "audio/mp4", extension: "m4a" },
];

type Phase = "idle" | "permission" | "recording" | "finishing";

function releaseMicrophone(stream?: MediaStream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function VoiceRecorder({
  busy = false,
  onRecording,
  onActiveChange,
}: {
  /** A reply is pending: no new recording may start, but one in progress can still be stopped. */
  busy?: boolean;
  onRecording: (file: File) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const active = useRef<MediaRecorder | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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

  async function start() {
    if (busy) return;
    setError("");
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
    let stream: MediaStream | undefined;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        releaseMicrophone(stream);
        return;
      }

      const recorder = new MediaRecorder(stream, { mimeType: format.type, audioBitsPerSecond: 64_000 });
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
        active.current = null;
        setPhase("idle");
        onActiveChange(false);
        if (failure || !size) {
          setError(failure || "The recording was empty. Try again.");
          return;
        }
        onRecording(new File(chunks, `recording.${format.extension}`, { type: recorder.mimeType }));
      };

      active.current = recorder;
      recorder.start(500);
      setPhase("recording");
    } catch (error) {
      releaseMicrophone(stream);
      active.current = null;
      if (!mounted.current) return;
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

  function stop() {
    const recorder = active.current;
    if (recorder?.state !== "recording") return;
    setPhase("finishing");
    recorder.stop();
  }

  const recording = phase === "recording";
  const waiting = busy && phase === "idle";
  return (
    <div className="voice-recorder">
      <button
        className={`icon-btn${recording ? " recording" : ""}`}
        type="button"
        aria-label={recording ? "Stop recording" : "Record voice note"}
        title={recording ? "Stop recording" : waiting ? "Wait for the reply before recording" : "Record voice note"}
        disabled={phase === "permission" || phase === "finishing" || waiting}
        onClick={recording ? stop : () => void start()}
      >
        {recording ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        )}
      </button>
      {phase !== "idle" && (
        <span role="status" className="muted voice-status">
          {phase === "permission" ? "Waiting for microphone access…" : recording ? "Recording…" : "Finishing…"}
        </span>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
