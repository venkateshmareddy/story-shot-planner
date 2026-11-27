import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../src/app/api/story/transcribe/route.ts";
import { audioLabel, audioMatches, sniffAudio, validateAudioFile } from "../src/lib/audio.ts";
import { MAX_VOICE_BYTES } from "../src/lib/story-input.ts";

const ID3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
const MPEG_FRAME = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00]);
const WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);
const M4A = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const TEXT = new TextEncoder().encode("Once upon a time");

test("validateAudioFile accepts each format by extension and declared MIME type", () => {
  assert.deepEqual(validateAudioFile({ name: "note.mp3", type: "audio/mpeg", size: 100 }), { ok: true, extension: "mp3" });
  assert.deepEqual(validateAudioFile({ name: "NOTE.WAV", type: "", size: 100 }), { ok: true, extension: "wav" });
  assert.deepEqual(validateAudioFile({ name: "memo.m4a", type: "audio/x-m4a", size: 100 }), { ok: true, extension: "m4a" });
  assert.deepEqual(validateAudioFile({ name: "recording.webm", type: "audio/webm;codecs=opus", size: 100 }), {
    ok: true,
    extension: "webm",
  });
  assert.deepEqual(validateAudioFile({ name: "recording.m4a", type: "audio/mp4", size: MAX_VOICE_BYTES }), {
    ok: true,
    extension: "m4a",
  });
});

test("validateAudioFile rejects wrong extensions, mismatched MIME types and bad sizes", () => {
  const error = (file: { name: string; type: string; size: number }) => {
    const result = validateAudioFile(file);
    assert.equal(result.ok, false, file.name);
    return result.ok ? "" : result.error;
  };
  assert.equal(error({ name: "note.ogg", type: "audio/ogg", size: 100 }), "Choose an MP3, WAV, M4A or WebM audio file.");
  assert.equal(error({ name: "note", type: "audio/mpeg", size: 100 }), "Choose an MP3, WAV, M4A or WebM audio file.");
  assert.equal(error({ name: "note.mp3.exe", type: "", size: 100 }), "Choose an MP3, WAV, M4A or WebM audio file.");
  assert.match(error({ name: "note.mp3", type: "audio/wav", size: 100 }), /audio\/wav, not MP3 audio/);
  assert.match(error({ name: "clip.webm", type: "video/mp4", size: 100 }), /not WebM audio/);
  assert.equal(error({ name: "note.mp3", type: "audio/mpeg", size: 0 }), "The audio file is empty.");
  assert.match(error({ name: "note.mp3", type: "audio/mpeg", size: MAX_VOICE_BYTES + 1 }), /4 MB or smaller/);
});

test("sniffAudio identifies real audio from its first bytes", () => {
  assert.equal(sniffAudio(ID3), "mp3");
  assert.equal(sniffAudio(MPEG_FRAME), "mp3");
  assert.equal(sniffAudio(WAV), "wav");
  assert.equal(sniffAudio(M4A), "m4a");
  assert.equal(sniffAudio(WEBM), "webm");
  assert.equal(sniffAudio(WEBP), null);
  assert.equal(sniffAudio(TEXT), null);
  assert.equal(sniffAudio(new TextEncoder().encode("OggS\0\x02")), null);
  assert.equal(sniffAudio(new Uint8Array()), null);
  assert.equal(sniffAudio(Uint8Array.from([0xff])), null);
});

test("audioMatches only accepts bytes of the declared format", () => {
  assert.ok(audioMatches("mp3", ID3));
  assert.ok(audioMatches("webm", WEBM));
  assert.ok(!audioMatches("mp3", WAV));
  assert.ok(!audioMatches("wav", WEBP));
  assert.ok(!audioMatches("m4a", WEBM));
  assert.ok(!audioMatches("webm", TEXT));
  assert.equal(audioLabel("m4a"), "M4A");
  assert.equal(audioLabel("webm"), "WebM");
});

function upload(body: Uint8Array, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/story/transcribe", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...headers },
    body,
  });
}

async function withoutKey(run: () => Promise<void>) {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await run();
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
}

test("transcribe rejects unknown extensions and mismatched declared types before reading audio", async () => {
  await withoutKey(async () => {
    for (const extension of [undefined, "", "ogg", "constructor", "__proto__", "mp3.exe"]) {
      const response = await POST(upload(ID3, extension === undefined ? {} : { "x-audio-extension": extension }));
      assert.equal(response.status, 415, String(extension));
    }
    const mismatch = await POST(upload(ID3, { "x-audio-extension": "mp3", "x-audio-type": "audio/wav" }));
    assert.equal(mismatch.status, 415);
    assert.equal((await mismatch.json()).error, "This file's type doesn't match MP3 audio. Choose a real MP3 file.");
  });
});

test("transcribe keeps size, empty and byte-signature checks", async () => {
  await withoutKey(async () => {
    const big = await POST(upload(ID3, { "x-audio-extension": "mp3", "content-length": String(MAX_VOICE_BYTES + 1) }));
    assert.equal(big.status, 413);
    assert.equal((await POST(upload(new Uint8Array(MAX_VOICE_BYTES + 1), { "x-audio-extension": "mp3" }))).status, 413);
    assert.equal((await POST(upload(new Uint8Array(), { "x-audio-extension": "mp3" }))).status, 400);

    const fake = await POST(upload(WAV, { "x-audio-extension": "mp3", "x-audio-type": "audio/mpeg" }));
    assert.equal(fake.status, 415);
    assert.equal((await fake.json()).error, "This file doesn't look like real MP3 audio.");

    const text = await POST(upload(TEXT, { "x-audio-extension": "webm" }));
    assert.equal(text.status, 415);
    assert.equal((await text.json()).error, "This file doesn't look like real WebM audio.");
  });
});

test("real audio, including browser recordings, reaches the key check", async () => {
  await withoutKey(async () => {
    const cases: [Uint8Array, Record<string, string>][] = [
      [WEBM, { "x-audio-extension": "webm", "x-audio-type": "audio/webm;codecs=opus" }],
      [M4A, { "x-audio-extension": "m4a", "x-audio-type": "audio/mp4" }],
      [MPEG_FRAME, { "x-audio-extension": "MP3" }],
      [WAV, { "x-audio-extension": "wav", "x-audio-type": "audio/x-wav" }],
    ];
    for (const [bytes, headers] of cases) {
      const response = await POST(upload(bytes, headers));
      assert.equal(response.status, 503, headers["x-audio-extension"]);
      assert.match((await response.json()).error, /OPENAI_API_KEY/);
    }
  });
});
