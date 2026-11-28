// Prepares audio for voice-to-text in the browser. Client-safe; Web Audio is only touched when called.
import { type AudioExtension, audioExtensionOf } from "./audio";
import { encodeWav, SPEECH_SAMPLE_RATE, wavByteLength } from "./audio-wav";
import { MAX_VOICE_BYTES } from "./story-input";

/** Browser recordings and phone memos; Gemini documents WAV, MP3, AIFF, AAC, OGG and FLAC, not these containers. */
const CONVERT_TO_WAV: ReadonlySet<AudioExtension> = new Set(["m4a", "webm"]);

export type VoiceUpload = { body: Blob; extension: string; type: string };

/** Null when the browser can't decode the audio or the WAV would exceed `maxBytes`: the caller sends the original. */
export async function speechWav(audio: Blob, maxBytes = MAX_VOICE_BYTES): Promise<Blob | null> {
  if (typeof OfflineAudioContext !== "function") return null;
  try {
    const decoded = await new OfflineAudioContext(1, 1, SPEECH_SAMPLE_RATE).decodeAudioData(await audio.arrayBuffer());
    const frames = Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE);
    if (!frames || wavByteLength(frames) > maxBytes) return null;
    const context = new OfflineAudioContext(1, frames, SPEECH_SAMPLE_RATE);
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    return new Blob([encodeWav(rendered.getChannelData(0), SPEECH_SAMPLE_RATE)], { type: "audio/wav" });
  } catch {
    return null;
  }
}

export async function prepareVoiceUpload(file: File): Promise<VoiceUpload> {
  const extension = audioExtensionOf(file.name);
  if (extension && CONVERT_TO_WAV.has(extension)) {
    const wav = await speechWav(file);
    if (wav) return { body: wav, extension: "wav", type: "audio/wav" };
  }
  return { body: file, extension: file.name.split(".").pop()?.toLowerCase() ?? "", type: file.type };
}
