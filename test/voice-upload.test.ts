import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  audioMatches,
  formatRecordingTime,
  MAX_RECORDING_SECONDS,
  RECORDING_CAP_NOTE,
  sniffAudio,
} from "../src/lib/audio.ts";
import { encodeWav, SPEECH_SAMPLE_RATE, WAV_HEADER_BYTES, wavByteLength } from "../src/lib/audio-wav.ts";
import { stoppedResult } from "../src/lib/request-stop.ts";
import { createSession } from "../src/lib/session.ts";
import { MAX_VOICE_BYTES } from "../src/lib/story-input.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";
import { transcribeVoice } from "../src/lib/studio-agent.ts";
import {
  decodeTranscribeHint,
  encodeTranscribeHint,
  MAX_HINT_HEADER,
  MAX_HINT_NAMES,
  sanitizeHint,
  TRANSCRIBE_HINT_HEADER,
  transcribeHintFor,
} from "../src/lib/transcription.ts";
import { appendToDraft, routeLongText } from "../src/lib/upload.ts";
import { prepareVoiceUpload, speechWav } from "../src/lib/voice-upload.ts";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globals.OfflineAudioContext;
});

const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);

/** Stands in for the browser's OfflineAudioContext: decodes to `seconds` of stereo audio at the context rate. */
function fakeWebAudio(seconds: number, options: { decode?: Promise<void> } = {}) {
  const created: { channels: number; length: number; sampleRate: number }[] = [];
  class FakeOfflineAudioContext {
    readonly destination = {};
    constructor(
      readonly channels: number,
      readonly length: number,
      readonly sampleRate: number,
    ) {
      created.push({ channels, length, sampleRate });
    }
    async decodeAudioData() {
      await options.decode;
      return { duration: seconds, sampleRate: this.sampleRate, numberOfChannels: 2, length: seconds * this.sampleRate };
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() {} };
    }
    async startRendering() {
      const data = new Float32Array(this.length).fill(0.5);
      return { getChannelData: () => data };
    }
  }
  globals.OfflineAudioContext = FakeOfflineAudioContext;
  return created;
}

function recordFetch(reply: unknown = { text: "Mara climbs the stairs.", usage: undefined }) {
  const sent: { headers: Headers; body: Blob }[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ headers: new Headers(init?.headers), body: init?.body as Blob });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
}

test("encodeWav writes a 16 kHz mono 16-bit PCM WAV with the right sizes and clamped samples", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2, Number.NaN, 0.5]));
  const view = new DataView(wav.buffer);
  const ascii = (offset: number) => String.fromCharCode(...wav.slice(offset, offset + 4));
  assert.equal(wav.byteLength, WAV_HEADER_BYTES + 6 * 2);
  assert.equal(wav.byteLength, wavByteLength(6));
  assert.equal(ascii(0), "RIFF");
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(ascii(8), "WAVE");
  assert.equal(ascii(12), "fmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), SPEECH_SAMPLE_RATE);
  assert.equal(SPEECH_SAMPLE_RATE, 16_000);
  assert.equal(view.getUint32(28, true), 32_000, "byte rate");
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(ascii(36), "data");
  assert.equal(view.getUint32(40, true), 12);
  const samples = Array.from({ length: 6 }, (_, index) => view.getInt16(44 + index * 2, true));
  assert.deepEqual(samples, [0, 32767, -32768, 32767, 0, 16384]);
  assert.equal(sniffAudio(wav), "wav");
  assert.ok(audioMatches("wav", wav), "the route's byte check accepts it");
});

test("a recording at the 2-minute cap fits the 4 MB upload limit as WAV; the timer reads m:ss", () => {
  assert.equal(MAX_RECORDING_SECONDS, 120);
  assert.ok(wavByteLength(MAX_RECORDING_SECONDS * SPEECH_SAMPLE_RATE) <= MAX_VOICE_BYTES);
  assert.ok(wavByteLength((MAX_RECORDING_SECONDS + 3) * SPEECH_SAMPLE_RATE) <= MAX_VOICE_BYTES, "room for a late stop");
  assert.equal(formatRecordingTime(0), "0:00");
  assert.equal(formatRecordingTime(7.9), "0:07");
  assert.equal(formatRecordingTime(65), "1:05");
  assert.equal(formatRecordingTime(MAX_RECORDING_SECONDS), "2:00");
  assert.equal(formatRecordingTime(-3), "0:00");
  assert.equal(formatRecordingTime(Number.NaN), "0:00");
  assert.match(RECORDING_CAP_NOTE, /2:00/);
});

test("speechWav resamples to 16 kHz mono; it gives up when Web Audio is missing or the WAV would be too big", async () => {
  assert.equal(await speechWav(new Blob([WEBM])), null, "no Web Audio (server, old browser)");
  const created = fakeWebAudio(2);
  const wav = await speechWav(new Blob([WEBM]));
  assert.ok(wav);
  assert.equal(wav.type, "audio/wav");
  assert.equal(wav.size, wavByteLength(2 * SPEECH_SAMPLE_RATE));
  assert.deepEqual(created, [
    { channels: 1, length: 1, sampleRate: SPEECH_SAMPLE_RATE },
    { channels: 1, length: 2 * SPEECH_SAMPLE_RATE, sampleRate: SPEECH_SAMPLE_RATE },
  ]);
  const bytes = new Uint8Array(await wav.arrayBuffer());
  assert.equal(sniffAudio(bytes), "wav");

  fakeWebAudio(MAX_RECORDING_SECONDS * 2);
  assert.equal(await speechWav(new Blob([WEBM])), null, "too big as WAV: the original is sent instead");
});

test("prepareVoiceUpload converts WebM/M4A recordings and sends MP3/WAV as they are", async () => {
  const mp3 = new File([MP3], "note.mp3", { type: "audio/mpeg" });
  fakeWebAudio(1);
  const asIs = await prepareVoiceUpload(mp3);
  assert.equal(asIs.body, mp3);
  assert.deepEqual([asIs.extension, asIs.type], ["mp3", "audio/mpeg"]);

  for (const file of [
    new File([WEBM], "recording.webm", { type: "audio/webm;codecs=opus" }),
    new File([WEBM], "memo.M4A", { type: "audio/mp4" }),
  ]) {
    const converted = await prepareVoiceUpload(file);
    assert.deepEqual([converted.extension, converted.type], ["wav", "audio/wav"], file.name);
    assert.equal(converted.body.size, wavByteLength(SPEECH_SAMPLE_RATE));
  }

  delete globals.OfflineAudioContext;
  const webm = new File([WEBM], "recording.webm", { type: "audio/webm" });
  const fallback = await prepareVoiceUpload(webm);
  assert.equal(fallback.body, webm);
  assert.deepEqual([fallback.extension, fallback.type], ["webm", "audio/webm"]);
});

test("transcribeVoice uploads the converted WAV with the project hint and keeps the caller's signal", async () => {
  fakeWebAudio(1);
  const sent = recordFetch();
  const signal = new AbortController().signal;
  const hint = { title: "The Lighthouse Keeper", names: ["Mara", "José"] };
  const result = await transcribeVoice(new File([WEBM], "recording.webm", { type: "audio/webm" }), { signal, hint });
  assert.deepEqual(result, { ok: true, text: "Mara climbs the stairs.", usage: undefined });
  assert.equal(sent.length, 1);
  const [{ headers, body }] = sent;
  assert.equal(headers.get("x-audio-extension"), "wav");
  assert.equal(headers.get("x-audio-type"), "audio/wav");
  assert.equal(sniffAudio(new Uint8Array(await body.arrayBuffer())), "wav");
  assert.deepEqual(decodeTranscribeHint(headers.get(TRANSCRIBE_HINT_HEADER)), { ok: true, hint });

  const plain = recordFetch();
  await transcribeVoice(new File([MP3], "note.mp3", { type: "audio/mpeg" }));
  assert.equal(plain[0].headers.get(TRANSCRIBE_HINT_HEADER), null, "no hint, no header");
  assert.equal(plain[0].headers.get("x-audio-extension"), "mp3");
});

test("Stop during the WAV conversion returns a stopped result and never uploads", async () => {
  let finishDecode = () => {};
  const decode = new Promise<void>((resolve) => {
    finishDecode = resolve;
  });
  fakeWebAudio(1, { decode });
  const sent = recordFetch();
  const controller = new AbortController();
  const pending = transcribeVoice(new File([WEBM], "recording.webm", { type: "audio/webm" }), { signal: controller.signal });
  controller.abort();
  finishDecode();
  assert.deepEqual(await pending, stoppedResult());
  assert.equal(sent.length, 0);
});

test("the hint is built from the title, plan names and the leading name of character/place facts", () => {
  const plan: ShotPlan = {
    title: "The Keeper",
    logline: "",
    intent: "",
    characters: [{ name: "Mara", role: "", look: "", personality: "", voice: "" }],
    locations: [{ name: "North Pier", description: "" }],
    scenes: [],
    reviewNotes: [],
  };
  const session = {
    ...createSession("The Lighthouse Keeper"),
    plan,
    context: {
      facts: [
        { category: "characters", label: "Main character", value: "Mara, the keeper", source: "user", approved: true },
        { category: "characters", label: "Friend", value: "Ravi (ten, loves trains)", source: "user", approved: true },
        {
          category: "locations",
          label: "Setting",
          value: "An island battered by storms every winter where nobody visits",
          source: "ai",
          approved: false,
        },
        { category: "tone", label: "Tone", value: "Quiet", source: "user", approved: true },
      ],
      unresolved: [],
    },
  } as Parameters<typeof transcribeHintFor>[0];
  assert.deepEqual(transcribeHintFor(session), { title: "The Lighthouse Keeper", names: ["Mara", "North Pier", "Ravi"] });
  assert.deepEqual(transcribeHintFor(createSession("Untitled")), { title: "Untitled", names: [] });
});

test("encoding keeps Unicode names, drops trailing names to fit the header budget, and sends nothing when empty", () => {
  const hint = { title: "Le Phare", names: ["José", "Zoë", "李雷", "Ольга"] };
  assert.deepEqual(decodeTranscribeHint(encodeTranscribeHint(hint)), { ok: true, hint });
  assert.equal(encodeTranscribeHint({ title: "", names: [] }), "");
  assert.equal(encodeTranscribeHint({ title: "  ", names: [" ", ""] }), "");

  const wide = Array.from({ length: MAX_HINT_NAMES }, (_, index) => `${"名".repeat(50)}${index}`);
  const encoded = encodeTranscribeHint({ title: "T", names: wide });
  assert.ok(encoded.length > 0 && encoded.length <= MAX_HINT_HEADER);
  const decoded = decodeTranscribeHint(encoded);
  assert.ok(decoded.ok && decoded.hint.names.length < MAX_HINT_NAMES && decoded.hint.names[0] === wide[0]);

  assert.deepEqual(sanitizeHint({ title: "A\tB", names: ["x".repeat(61), "Ok", "OK", ...wide, "late"] }).names.length, MAX_HINT_NAMES);
});

test("a transcript goes after the draft with a space; a long one still becomes the story source in discovery", () => {
  assert.equal(appendToDraft("", "Mara climbs."), "Mara climbs.");
  assert.equal(appendToDraft("   ", "Mara climbs."), "Mara climbs.");
  assert.equal(appendToDraft("The opening is  ", "Mara climbs."), "The opening is Mara climbs.");
  assert.equal(appendToDraft("Notes", "Story text", "\n\n"), "Notes\n\nStory text");
  assert.equal(routeLongText({ chars: 200, origin: "transcript", phase: "discovery", composerLimit: 2_000 }), "composer");
  assert.equal(routeLongText({ chars: 5_000, origin: "transcript", phase: "discovery", composerLimit: 2_000 }), "source");
  assert.equal(routeLongText({ chars: 5_000, origin: "transcript", phase: "refining", composerLimit: 2_000 }), "too-long-for-chat");
});
