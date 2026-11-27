import { getOpenAI, jsonError, modelError, TRANSCRIPTION_MODEL } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { MAX_STORY_CHARACTERS, MAX_VOICE_BYTES } from "@/lib/story-input";
import { toUsageRecord } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 100;

const formats = new Map([
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["m4a", "audio/mp4"],
  ["webm", "audio/webm"],
]);

export async function POST(request: Request) {
  const extension = request.headers.get("x-audio-extension") ?? "";
  const type = formats.get(extension);
  if (!type) return jsonError("Choose an MP3, WAV, M4A, or WebM file.", 415);

  let audio: Uint8Array<ArrayBuffer>;
  try {
    const bytes = await readBody(request, MAX_VOICE_BYTES);
    if (!bytes) return jsonError("Choose a voice note that’s 4 MB or smaller.", 413);
    if (!bytes.length) return jsonError("The voice note is empty.", 400);
    audio = Uint8Array.from(bytes);
  } catch {
    return jsonError("The upload was interrupted. Try again.", 400);
  }

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to transcribe audio.", 503);

  try {
    const result = await client.audio.transcriptions.create({
      model: TRANSCRIPTION_MODEL,
      file: new File([audio], `voice-note.${extension}`, { type }),
    });
    const returned = (result as { model?: unknown }).model;
    const model = typeof returned === "string" && returned ? returned : TRANSCRIPTION_MODEL;
    const usage = toUsageRecord("transcribe", model, result.usage);
    console.info("Model usage", { step: "transcribe", model, usage });
    if (!result.text?.trim()) return jsonError("No speech was found in the voice note.", 422);
    if (result.text.length > MAX_STORY_CHARACTERS) return jsonError("Use a shorter voice note.", 422);
    return Response.json({ text: result.text, usage });
  } catch (error) {
    return modelError(error, "transcribe");
  }
}
