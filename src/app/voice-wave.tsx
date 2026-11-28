"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { barScale, emptyLevels, pushLevel, rmsLevel, WAVE_BARS, waveMode } from "@/lib/voice-ui";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const BAR_STEP_MS = 70;
const LEVEL_STEP_MS = 250;
const BAR_KEYS = Array.from({ length: WAVE_BARS }, (_, index) => `bar-${index}`);

type Meter = { context: AudioContext; source: MediaStreamAudioSourceNode; analyser: AnalyserNode };

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const legacy = (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return window.AudioContext ?? legacy ?? null;
}

function openMeter(stream: MediaStream): Meter | null {
  const Context = audioContextClass();
  if (!Context) return null;
  let context: AudioContext | undefined;
  try {
    context = new Context();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    return { context, source, analyser };
  } catch {
    void context?.close().catch(() => undefined);
    return null;
  }
}

function closeMeter({ context, source, analyser }: Meter) {
  source.disconnect();
  analyser.disconnect();
  if (context.state !== "closed") void context.close().catch(() => undefined);
}

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

/** Live loudness from the recorder's own stream; never opens a second microphone. */
export function VoiceWave({ stream }: { stream: MediaStream | null }) {
  const reducedMotion = usePrefersReducedMotion();
  const [audioFailed, setAudioFailed] = useState(false);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const levelFill = useRef<HTMLSpanElement>(null);
  const reduced = useRef(reducedMotion);
  reduced.current = reducedMotion;
  const mode = waveMode({
    webAudio: stream !== null && !audioFailed && audioContextClass() !== null,
    reducedMotion,
  });

  useEffect(() => {
    if (!stream) return;
    const meter = openMeter(stream);
    if (!meter) {
      setAudioFailed(true);
      return;
    }
    void meter.context.resume().catch(() => undefined);
    const samples = new Uint8Array(meter.analyser.fftSize);
    let levels = emptyLevels();
    let last = 0;
    let frame = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < (reduced.current ? LEVEL_STEP_MS : BAR_STEP_MS)) return;
      last = now;
      meter.analyser.getByteTimeDomainData(samples);
      const level = rmsLevel(samples);
      levelFill.current?.style.setProperty("--voice-level", level.toFixed(2));
      levels = pushLevel(levels, level);
      for (let index = 0; index < levels.length; index += 1) {
        bars.current[index]?.style.setProperty("--voice-bar", barScale(levels[index]).toFixed(3));
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      closeMeter(meter);
    };
  }, [stream]);

  return (
    <span className="voice-wave" data-mode={mode} aria-hidden="true">
      {mode === "bars" &&
        BAR_KEYS.map((key, index) => (
          <span
            key={key}
            className="voice-wave-bar"
            ref={(element) => {
              bars.current[index] = element;
            }}
          />
        ))}
      {mode === "level" && (
        <span className="voice-level">
          <span ref={levelFill} className="voice-level-fill" />
        </span>
      )}
      {mode === "pulse" && <span className="voice-wave-pulse" />}
    </span>
  );
}
