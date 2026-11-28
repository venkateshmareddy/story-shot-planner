export const SPEECH_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

export function wavByteLength(frames: number): number {
  return WAV_HEADER_BYTES + Math.max(0, Math.floor(frames)) * BYTES_PER_SAMPLE;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

export function encodeWav(samples: Float32Array, sampleRate = SPEECH_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const view = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + dataBytes));
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0));
    view.setInt16(WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return new Uint8Array(view.buffer);
}
