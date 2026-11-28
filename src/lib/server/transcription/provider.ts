import type { AudioExtension } from "@/lib/audio";
import { brainFile } from "@/lib/server/brain";
import { SOURCE_RULES } from "@/lib/server/prompts";
import type { TranscribeHint } from "@/lib/transcription";
import type { UsageRecord } from "@/lib/usage";

export const TRANSCRIBE_INSTRUCTIONS = [SOURCE_RULES, brainFile("helpers/TRANSCRIBE.md")].join("\n");

export type TranscriptionInput = {
  audio: Uint8Array;
  format: AudioExtension;
  hint: TranscribeHint;
  signal: AbortSignal;
};

export type Transcript = { text: string; usage: UsageRecord };

export type TranscriptionProvider = {
  readonly provider: string;
  readonly model: string;
  transcribe: (input: TranscriptionInput) => Promise<Transcript>;
};

const FAILURES = {
  not_configured: { status: 503, message: "Voice-to-text isn’t set up yet." },
  auth: { status: 503, message: "Voice-to-text couldn’t connect. Check the Gemini API key." },
  model: { status: 503, message: "Voice-to-text couldn’t connect. Check the Gemini model name." },
  unsupported_model: {
    status: 503,
    message: "This voice model can’t be used for voice-to-text. Choose another in Settings → Models.",
  },
  unavailable: { status: 503, message: "Voice-to-text isn’t available for this Gemini account or region." },
  rate_limited: { status: 429, message: "Voice-to-text is busy — try again in a minute." },
  busy: { status: 503, message: "Gemini is busy right now — try again in a minute." },
  bad_audio: { status: 422, message: "This audio couldn’t be read. Record again, or upload an MP3 or WAV file." },
  blocked: { status: 422, message: "This voice note couldn’t be turned into text. Try again or type your message." },
  too_long: { status: 422, message: "Use a shorter voice note." },
  no_speech: { status: 422, message: "No speech was found in the voice note." },
  timeout: { status: 504, message: "Turning your voice into text took too long. Try again or use a shorter voice note." },
  stopped: { status: 499, message: "Stopped." },
  upstream: { status: 502, message: "Voice-to-text couldn’t finish. Try again." },
  invalid_response: { status: 502, message: "Voice-to-text couldn’t finish. Try again." },
} as const satisfies Record<string, { status: number; message: string }>;

export type TranscriptionFailure = keyof typeof FAILURES;

/** Diagnostic metadata only: never audio, transcript, hint text or provider error messages. */
export type TranscriptionErrorDetail = { status?: number; code?: string; reason?: string; error?: string };

export class TranscriptionError extends Error {
  constructor(
    readonly failure: TranscriptionFailure,
    readonly detail: TranscriptionErrorDetail = {},
  ) {
    super(`Transcription failed: ${failure}`);
    this.name = "TranscriptionError";
  }
}

export function transcriptionFailure(failure: TranscriptionFailure): { status: number; message: string } {
  return FAILURES[failure];
}

/** The data part sent before the audio; the brain explains how to use it. */
export function transcriptionHintText(hint: TranscribeHint): string {
  return [
    `Project title: ${hint.title || "(none)"}`,
    `Names in this project: ${hint.names.length ? hint.names.join("; ") : "(none)"}`,
  ].join("\n");
}

// A user text part, not a system instruction: dedicated transcribe models reject developer instructions.
export function transcriptionPrompt(hint: TranscribeHint): string {
  return [TRANSCRIBE_INSTRUCTIONS, transcriptionHintText(hint)].join("\n");
}

export function transcriptionErrorResponse(error: unknown, context: { provider: string; model: string }): Response {
  const known = error instanceof TranscriptionError;
  const failure: TranscriptionFailure = known ? error.failure : "upstream";
  if (failure !== "stopped") {
    const detail = known ? error.detail : { error: error instanceof Error ? error.name : typeof error };
    console.warn("Transcription failed", { step: "transcribe", ...context, failure, ...detail });
  }
  const { status, message } = FAILURES[failure];
  return Response.json({ error: message }, { status });
}
