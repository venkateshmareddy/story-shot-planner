// Audio upload validation shared by the client and the transcribe route. Pure and client-safe.
import { MAX_VOICE_BYTES } from "./story-input";

export const AUDIO_FORMATS = {
  mp3: ["audio/mpeg", "audio/mp3", "audio/mpeg3", "audio/x-mpeg-3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"],
  webm: ["audio/webm", "video/webm"],
} as const;

export type AudioExtension = keyof typeof AUDIO_FORMATS;

export const AUDIO_ACCEPT = ".mp3,.wav,.m4a,.webm,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/webm";

const LABEL: Record<AudioExtension, string> = { mp3: "MP3", wav: "WAV", m4a: "M4A", webm: "WebM" };

export function audioExtensionOf(name: string): AudioExtension | null {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return Object.hasOwn(AUDIO_FORMATS, extension) ? (extension as AudioExtension) : null;
}

export type AudioCheck = { ok: true; extension: AudioExtension } | { ok: false; error: string };

/** Validate an audio file's name, declared MIME type and size before upload. */
export function validateAudioFile(file: { name: string; type: string; size: number }): AudioCheck {
  const extension = audioExtensionOf(file.name);
  if (!extension) return { ok: false, error: "Choose an MP3, WAV, M4A or WebM audio file." };
  const mime = file.type.split(";")[0].trim().toLowerCase();
  if (mime && !(AUDIO_FORMATS[extension] as readonly string[]).includes(mime)) {
    return { ok: false, error: `This file says it's ${mime}, not ${LABEL[extension]} audio. Choose a real ${LABEL[extension]} file.` };
  }
  if (file.size <= 0) return { ok: false, error: "The audio file is empty." };
  if (file.size > MAX_VOICE_BYTES) return { ok: false, error: "Choose an audio file that's 4 MB or smaller." };
  return { ok: true, extension };
}

/** Identify audio from its first bytes. */
export function sniffAudio(bytes: Uint8Array): AudioExtension | null {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x49, 0x44, 0x33)) return "mp3"; // "ID3" tag
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x41, 0x56, 0x45)) return "wav"; // "RIFF"…"WAVE"
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "m4a"; // "ftyp" (MP4/M4A container)
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm"; // EBML
  return null;
}

/** True when the bytes really are the declared format. */
export function audioMatches(extension: AudioExtension, bytes: Uint8Array): boolean {
  return sniffAudio(bytes) === extension;
}

export function audioLabel(extension: AudioExtension): string {
  return LABEL[extension];
}

/** A 16 kHz mono WAV of this length stays under MAX_VOICE_BYTES (32 KB a second). */
export const MAX_RECORDING_SECONDS = 120;

export function formatRecordingTime(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export const RECORDING_CAP_NOTE = `Recording stopped at ${formatRecordingTime(MAX_RECORDING_SECONDS)}, the longest a voice note can be.`;
