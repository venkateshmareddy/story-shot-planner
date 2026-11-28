// Display rules for voice input inside the chat composer. Pure and client-safe.
import { formatRecordingTime, MAX_RECORDING_SECONDS } from "./audio";
import { STOP_LABEL } from "./request-stop";

export type RecorderPhase = "idle" | "permission" | "recording" | "finishing";
export type ComposerVoiceStage = "idle" | "permission" | "recording" | "transcribing" | "error" | "done";
export type WaveMode = "bars" | "level" | "pulse";
export type RecordingKeyAction = "done" | "cancel" | null;
export type VoiceAddedEvent = "transcribed" | "edit" | "send" | "record" | "session";
export type VoiceNote = { text: string; srOnly: boolean };
export type SendButtonState =
  | { mode: "send"; label: "Send"; disabled: boolean }
  | { mode: "stop"; label: "Stop"; ariaLabel: string; disabled: false };

export const WARN_AT_SECONDS = MAX_RECORDING_SECONDS - 15;
export const RECORDING_HINT = `Speak naturally. Up to ${MAX_RECORDING_SECONDS / 60} minutes · Enter = Done · Esc = Cancel`;
export const RECORDING_WARNING = `Recording stops at ${formatRecordingTime(MAX_RECORDING_SECONDS)}.`;
export const MIC_WAITING = "Waiting for microphone access…";
export const TRANSCRIBING_TEXT = "Turning your voice into text…";
export const TRANSCRIBED_HELPER = "From your voice: check it, then press Send";
export const VOICE_FLASH_MS = 1_200;
export const WAVE_BARS = 28;

const SILENCE_DB = -60;
const LOUD_DB = -12;
const MIN_BAR = 0.12;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** What the composer's text area shows; the recorder wins over transcription so a new take is never hidden. */
export function composerVoiceStage(input: {
  recorder: RecorderPhase;
  transcribing: boolean;
  error: string;
  voiceAdded: number;
}): ComposerVoiceStage {
  if (input.recorder === "permission") return "permission";
  if (input.recorder !== "idle") return "recording";
  if (input.transcribing) return "transcribing";
  if (input.error) return "error";
  return input.voiceAdded > 0 ? "done" : "idle";
}

export function coversDraft(stage: ComposerVoiceStage): boolean {
  return stage === "recording" || stage === "transcribing";
}

export function voiceNote(input: { stage: ComposerVoiceStage; elapsed: number; note: string }): VoiceNote {
  switch (input.stage) {
    case "permission":
      return { text: MIC_WAITING, srOnly: false };
    case "recording":
      return { text: input.elapsed >= WARN_AT_SECONDS ? RECORDING_WARNING : RECORDING_HINT, srOnly: false };
    case "transcribing":
      return input.note ? { text: input.note, srOnly: false } : { text: TRANSCRIBING_TEXT, srOnly: true };
    case "done":
      return { text: TRANSCRIBED_HELPER, srOnly: false };
    default:
      return { text: input.note, srOnly: false };
  }
}

export function voiceAddedAfter(current: number, event: VoiceAddedEvent): number {
  return event === "transcribed" ? current + 1 : 0;
}

/** Enter on a focused button keeps its own meaning, so Enter on Cancel still cancels. */
export function recordingKeyAction(key: string, onButton = false): RecordingKeyAction {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && !onButton) return "done";
  return null;
}

export function waveMode(input: { webAudio: boolean; reducedMotion: boolean }): WaveMode {
  if (!input.webAudio) return "pulse";
  return input.reducedMotion ? "level" : "bars";
}

/** Byte time-domain samples centre on 128 for silence; loudness maps to 0–1 on a decibel scale. */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = (samples[index] - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  return clamp01((20 * Math.log10(rms) - SILENCE_DB) / (LOUD_DB - SILENCE_DB));
}

export function emptyLevels(size = WAVE_BARS): number[] {
  return Array.from({ length: size }, () => 0);
}

export function pushLevel(levels: readonly number[], level: number, size = WAVE_BARS): number[] {
  return [...levels, clamp01(level)].slice(-size);
}

export function barScale(level: number): number {
  return MIN_BAR + (1 - MIN_BAR) * clamp01(level);
}

export function sendButtonState(input: {
  busy: boolean;
  uploading: boolean;
  transcribing: boolean;
  recording: boolean;
  hasText: boolean;
}): SendButtonState {
  if (input.busy || input.uploading || input.transcribing) {
    return { mode: "stop", label: "Stop", ariaLabel: STOP_LABEL, disabled: false };
  }
  return { mode: "send", label: "Send", disabled: input.recording || !input.hasText };
}

/** The second click of a double-click on Send must not stop the request it just started. */
export function sendClickAction(mode: SendButtonState["mode"], clickCount: number): "send" | "stop" | "ignore" {
  if (mode === "send") return "send";
  return clickCount > 1 ? "ignore" : "stop";
}

export function stopTargets(input: { busy: boolean; uploading: boolean; transcribing: boolean }): {
  request: boolean;
  uploads: boolean;
} {
  return { request: input.busy, uploads: input.uploading || input.transcribing };
}
