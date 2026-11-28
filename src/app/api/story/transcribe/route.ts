import { AUDIO_FORMATS, type AudioExtension, audioLabel, audioMatches } from "@/lib/audio";
import { jsonError } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { resolveVoiceModel } from "@/lib/server/model-catalog";
import { createGeminiTranscriber, geminiConfigFromEnv } from "@/lib/server/transcription/gemini";
import { transcriptionErrorResponse, transcriptionFailure } from "@/lib/server/transcription/provider";
import { MAX_STORY_CHARACTERS, MAX_VOICE_BYTES } from "@/lib/story-input";
import { decodeTranscribeHint, TRANSCRIBE_HINT_HEADER } from "@/lib/transcription";

export const runtime = "nodejs";
export const maxDuration = 100;

function extensionFrom(header: string | null): AudioExtension | null {
  const extension = header?.trim().toLowerCase() ?? "";
  return Object.hasOwn(AUDIO_FORMATS, extension) ? (extension as AudioExtension) : null;
}

function declaredTypeMatches(extension: AudioExtension, header: string | null): boolean {
  const type = header?.split(";")[0].trim().toLowerCase() ?? "";
  return !type || (AUDIO_FORMATS[extension] as readonly string[]).includes(type);
}

function failure(name: Parameters<typeof transcriptionFailure>[0]) {
  const { message, status } = transcriptionFailure(name);
  return jsonError(message, status);
}

export async function POST(request: Request) {
  const extension = extensionFrom(request.headers.get("x-audio-extension"));
  if (!extension) return jsonError("Choose an MP3, WAV, M4A, or WebM file.", 415);
  const label = audioLabel(extension);
  if (!declaredTypeMatches(extension, request.headers.get("x-audio-type"))) {
    return jsonError(`This file's type doesn't match ${label} audio. Choose a real ${label} file.`, 415);
  }
  const hint = decodeTranscribeHint(request.headers.get(TRANSCRIBE_HINT_HEADER));
  if (!hint.ok) return jsonError(hint.error, 400);

  let audio: Uint8Array<ArrayBuffer>;
  try {
    const bytes = await readBody(request, MAX_VOICE_BYTES);
    if (!bytes) return jsonError("Choose a voice note that’s 4 MB or smaller.", 413);
    if (!bytes.length) return jsonError("The voice note is empty.", 400);
    audio = Uint8Array.from(bytes);
  } catch {
    return jsonError("The upload was interrupted. Try again.", 400);
  }
  if (!audioMatches(extension, audio)) return jsonError(`This file doesn't look like real ${label} audio.`, 415);

  const config = geminiConfigFromEnv();
  if (!config) return failure("not_configured");
  const transcriber = createGeminiTranscriber({ ...config, model: resolveVoiceModel(request) });

  try {
    const { text, usage } = await transcriber.transcribe({ audio, format: extension, hint: hint.hint, signal: request.signal });
    if (!text) return failure("no_speech");
    if (text.length > MAX_STORY_CHARACTERS) return failure("too_long");
    return Response.json({ text, usage });
  } catch (error) {
    return transcriptionErrorResponse(error, { provider: transcriber.provider, model: transcriber.model });
  }
}
