import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationPanel, type UploadingKind } from "../src/app/conversation-panel.tsx";
import { RecordingPanel, type VoiceRecorder } from "../src/app/voice-recorder.tsx";
import { MAX_RECORDING_SECONDS } from "../src/lib/audio.ts";
import { STOP_LABEL, stoppedResult } from "../src/lib/request-stop.ts";
import { createSession, type StorySession } from "../src/lib/session.ts";
import { transcribeVoice } from "../src/lib/studio-agent.ts";
import { appendToDraft } from "../src/lib/upload.ts";
import {
  barScale,
  type ComposerVoiceStage,
  composerVoiceStage,
  coversDraft,
  emptyLevels,
  MIC_WAITING,
  pushLevel,
  RECORDING_HINT,
  RECORDING_WARNING,
  type RecorderPhase,
  recordingKeyAction,
  rmsLevel,
  sendButtonState,
  sendClickAction,
  stopTargets,
  TRANSCRIBED_HELPER,
  TRANSCRIBING_TEXT,
  voiceAddedAfter,
  voiceNote,
  WARN_AT_SECONDS,
  WAVE_BARS,
  waveMode,
} from "../src/lib/voice-ui.ts";

const noop = () => {};
const globals = globalThis as unknown as Record<string, unknown>;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globals.HTMLButtonElement;
});

type PanelState = {
  busy?: boolean;
  input?: string;
  transcribing?: boolean;
  uploading?: UploadingKind | null;
  voiceError?: string;
  micError?: string;
  voiceAdded?: number;
  session?: StorySession;
};

function renderPanel(state: PanelState = {}): string {
  return renderToStaticMarkup(
    createElement(ConversationPanel, {
      session: state.session ?? createSession("Test"),
      busy: state.busy ?? false,
      error: "",
      input: state.input ?? "",
      transcribing: state.transcribing ?? false,
      voiceError: state.voiceError ?? "",
      micError: state.micError ?? "",
      voiceAdded: state.voiceAdded ?? 0,
      canGeneratePlan: false,
      uploading: state.uploading ?? null,
      stopNotice: "",
      openReport: null,
      onOpenReport: noop,
      onInput: noop,
      onSend: noop,
      onStop: noop,
      onStopUpload: noop,
      onQuickAction: noop,
      onDiscoveryAction: noop,
      onAnswerOption: noop,
      onGeneratePlan: noop,
      onAccept: noop,
      onReject: noop,
      onEditAnswer: () => true,
      onVoice: noop,
      onVoiceActive: noop,
      onClearMicError: noop,
      onUpload: noop,
      onRetry: noop,
    }),
  );
}

function between(html: string, open: RegExp, close: string): string {
  const start = html.search(open);
  assert.ok(start >= 0, `found ${open}`);
  const end = html.indexOf(close, start);
  return html.slice(start, end + close.length);
}

function composerField(html: string): string {
  const start = html.search(/<div class="composer-field/);
  assert.ok(start >= 0, "composer field rendered");
  const rest = html.slice(start);
  return rest.slice(0, rest.search(/<div class="voice-problem">|<p class="muted composer-note/));
}

function sendButton(html: string): string {
  const match = html.match(/<button class="button composer-send"[^>]*>[^<]*<\/button>/);
  assert.ok(match, "the composer has its Send/Stop button");
  return match[0];
}

function attachButton(html: string): string {
  const match = html.match(/<button class="icon-btn" type="button" aria-label="Attach[^>]*>/);
  assert.ok(match, "attach button rendered");
  return match[0];
}

function note(html: string): string {
  return between(html, /<p class="muted composer-note/, "</p>");
}

// --- Pure helpers ---

test("the recording hint, warning and waiting text use plain words and the 2-minute cap", () => {
  assert.equal(RECORDING_HINT, "Speak naturally. Up to 2 minutes · Enter = Done · Esc = Cancel");
  assert.equal(RECORDING_WARNING, "Recording stops at 2:00.");
  assert.equal(WARN_AT_SECONDS, MAX_RECORDING_SECONDS - 15);
  assert.equal(voiceNote({ stage: "recording", elapsed: 0, note: "" }).text, RECORDING_HINT);
  assert.equal(voiceNote({ stage: "recording", elapsed: WARN_AT_SECONDS - 1, note: "" }).text, RECORDING_HINT);
  assert.equal(voiceNote({ stage: "recording", elapsed: WARN_AT_SECONDS, note: "" }).text, RECORDING_WARNING);
  assert.deepEqual(voiceNote({ stage: "permission", elapsed: 0, note: "" }), { text: MIC_WAITING, srOnly: false });
});

test("while turning voice into text the note only speaks to screen readers unless there is a real note", () => {
  assert.deepEqual(voiceNote({ stage: "transcribing", elapsed: 0, note: "" }), { text: TRANSCRIBING_TEXT, srOnly: true });
  const capped = voiceNote({ stage: "transcribing", elapsed: 120, note: "Recording stopped at 2:00." });
  assert.deepEqual(capped, { text: "Recording stopped at 2:00.", srOnly: false });
  assert.deepEqual(voiceNote({ stage: "done", elapsed: 0, note: "" }), { text: TRANSCRIBED_HELPER, srOnly: false });
  assert.deepEqual(voiceNote({ stage: "idle", elapsed: 0, note: "Recording cancelled." }), {
    text: "Recording cancelled.",
    srOnly: false,
  });
  assert.equal(TRANSCRIBED_HELPER, "From your voice: check it, then press Send");
});

test("loudness from analyser samples: silence is 0, full scale is 1, louder is higher", () => {
  assert.equal(rmsLevel(new Uint8Array(512).fill(128)), 0);
  assert.equal(rmsLevel(new Uint8Array(0)), 0);
  const fullScale = Uint8Array.from({ length: 512 }, (_, index) => (index % 2 ? 0 : 255));
  assert.equal(rmsLevel(fullScale), 1);
  const wave = (amplitude: number) =>
    Uint8Array.from({ length: 512 }, (_, index) => Math.round(128 + amplitude * 127 * Math.sin((index / 512) * Math.PI * 16)));
  const quiet = rmsLevel(wave(0.01));
  const speech = rmsLevel(wave(0.1));
  const loud = rmsLevel(wave(0.5));
  assert.ok(quiet > 0 && quiet < speech && speech < loud && loud <= 1, `${quiet} < ${speech} < ${loud}`);
});

test("wave levels roll left, keep their bar count and never mutate the previous frame", () => {
  const start = emptyLevels();
  assert.equal(start.length, WAVE_BARS);
  assert.ok(WAVE_BARS >= 24 && WAVE_BARS <= 32);
  const next = pushLevel(start, 0.5);
  assert.equal(next.length, WAVE_BARS);
  assert.equal(next.at(-1), 0.5);
  assert.ok(start.every((level) => level === 0), "previous levels untouched");
  assert.deepEqual(pushLevel([0.1, 0.2, 0.3], 0.4, 3), [0.2, 0.3, 0.4]);
  assert.deepEqual(pushLevel([], 7, 3), [1], "levels are clamped to 0–1");
  assert.deepEqual(pushLevel([], Number.NaN, 3), [0]);
  assert.equal(barScale(0), 0.12, "silence keeps a short visible bar");
  assert.equal(barScale(1), 1);
  assert.ok(barScale(0.5) > barScale(0.2));
});

test("the wave falls back to a calm dot without Web Audio and to a static level bar for reduced motion", () => {
  assert.equal(waveMode({ webAudio: true, reducedMotion: false }), "bars");
  assert.equal(waveMode({ webAudio: true, reducedMotion: true }), "level");
  assert.equal(waveMode({ webAudio: false, reducedMotion: false }), "pulse");
  assert.equal(waveMode({ webAudio: false, reducedMotion: true }), "pulse");
});

test("keys while recording: Enter = Done, Esc = Cancel; Enter on a focused button keeps its own action", () => {
  assert.equal(recordingKeyAction("Enter"), "done");
  assert.equal(recordingKeyAction("Escape"), "cancel");
  assert.equal(recordingKeyAction("Escape", true), "cancel");
  assert.equal(recordingKeyAction("Enter", true), null);
  assert.equal(recordingKeyAction(" "), null);
  assert.equal(recordingKeyAction("a"), null);
});

test("the voice helper line shows after a transcript and clears on edit, send, a new take or another chat", () => {
  assert.equal(voiceAddedAfter(0, "transcribed"), 1);
  assert.equal(voiceAddedAfter(1, "transcribed"), 2, "a second transcript re-triggers the highlight");
  for (const event of ["edit", "send", "record", "session"] as const) assert.equal(voiceAddedAfter(3, event), 0, event);
  const stage = (voiceAdded: number, error = "") =>
    composerVoiceStage({ recorder: "idle", transcribing: false, error, voiceAdded });
  assert.equal(stage(1), "done");
  assert.equal(stage(0), "idle");
  assert.equal(stage(1, "Gemini is busy right now — try again in a minute."), "error", "an error replaces the helper");
});

test("composer stages: idle → permission → recording → transcribing → done, with error and cancel paths", () => {
  const stage = (recorder: RecorderPhase, transcribing: boolean, error = "", voiceAdded = 0): ComposerVoiceStage =>
    composerVoiceStage({ recorder, transcribing, error, voiceAdded });
  const happy = [
    stage("idle", false),
    stage("permission", false),
    stage("recording", false),
    stage("finishing", false),
    stage("idle", true),
    stage("idle", false, "", 1),
  ];
  assert.deepEqual(happy, ["idle", "permission", "recording", "recording", "transcribing", "done"]);
  assert.equal(stage("idle", false, "No speech was found in the voice note."), "error");
  assert.equal(stage("idle", false), "idle", "cancel returns to the plain box");
  assert.equal(stage("recording", true), "recording", "a new take is never hidden behind an older transcription");
  assert.deepEqual(
    (["idle", "permission", "recording", "transcribing", "error", "done"] as const).filter(coversDraft),
    ["recording", "transcribing"],
  );
});

test("the transcript is appended to the kept draft exactly once", () => {
  const draft = "Aswin walks";
  const transcript = "through the dark forest at stormy dusk.";
  const update = (current: string) => appendToDraft(current, transcript, " ");
  const once = update(draft);
  assert.equal(once, "Aswin walks through the dark forest at stormy dusk.");
  assert.equal(update(draft), once, "a re-run updater (React Strict Mode) gives the same text");
  assert.equal(once.split(transcript).length - 1, 1);
  assert.equal(update("   "), transcript, "an empty draft just becomes the transcript");
});

test("Send becomes Stop while any request runs, and returns to Send after", () => {
  const idle = { busy: false, uploading: false, transcribing: false, recording: false, hasText: true };
  assert.deepEqual(sendButtonState(idle), { mode: "send", label: "Send", disabled: false });
  assert.equal(sendButtonState({ ...idle, hasText: false }).disabled, true);
  assert.equal(sendButtonState({ ...idle, recording: true }).disabled, true, "no sending while recording");
  for (const running of [{ busy: true }, { uploading: true }, { transcribing: true }]) {
    const state = sendButtonState({ ...idle, hasText: false, ...running });
    assert.deepEqual(state, { mode: "stop", label: "Stop", ariaLabel: STOP_LABEL, disabled: false }, JSON.stringify(running));
  }
  assert.equal(STOP_LABEL, "Stop the current request");
});

test("the Stop click ends the right work and ignores the second click of a double-click on Send", () => {
  assert.equal(sendClickAction("send", 1), "send");
  assert.equal(sendClickAction("send", 2), "send");
  assert.equal(sendClickAction("stop", 1), "stop");
  assert.equal(sendClickAction("stop", 0), "stop", "keyboard activation stops");
  assert.equal(sendClickAction("stop", 2), "ignore");
  assert.deepEqual(stopTargets({ busy: true, uploading: false, transcribing: false }), { request: true, uploads: false });
  assert.deepEqual(stopTargets({ busy: false, uploading: false, transcribing: true }), { request: false, uploads: true });
  assert.deepEqual(stopTargets({ busy: false, uploading: true, transcribing: false }), { request: false, uploads: true });
  assert.deepEqual(stopTargets({ busy: true, uploading: false, transcribing: true }), { request: true, uploads: true });
});

test("Stop aborts a transcription that is already uploading", async () => {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;
  const controller = new AbortController();
  const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
  const pending = transcribeVoice(new File([MP3], "note.mp3", { type: "audio/mpeg" }), { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  assert.deepEqual(await pending, stoppedResult());
});

// --- Recording panel ---

function fakeRecorder(overrides: Partial<VoiceRecorder> = {}): VoiceRecorder & { calls: string[] } {
  const calls: string[] = [];
  return {
    phase: "recording",
    elapsed: 7,
    stream: null,
    error: "",
    note: "",
    start: () => calls.push("start"),
    finish: () => calls.push("finish"),
    cancel: () => calls.push("cancel"),
    clearError: () => calls.push("clearError"),
    micButton: { current: null },
    panel: { current: null },
    doneButton: { current: null },
    ...overrides,
    calls,
  };
}

type AnyElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function elements(node: ReactNode): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as AnyElement;
  return [element, ...elements(element.props.children)];
}

test("the recording panel shows the time, a live wave, Cancel and Done with their keys", () => {
  const html = renderToStaticMarkup(createElement(RecordingPanel, { recorder: fakeRecorder() }));
  assert.match(html, /^<fieldset class="voice-panel voice-panel-recording" tabindex="-1">/);
  assert.match(html, /<legend class="sr-only">Voice recording<\/legend>/);
  assert.match(html, /<span class="sr-only">Recording <\/span><span class="voice-panel-time" role="timer">0:07<\/span>/);
  assert.match(html, /<span class="voice-wave" data-mode="pulse" aria-hidden="true">/, "no Web Audio here: calm dot");
  const cancelAt = html.indexOf("Cancel</button>");
  const doneAt = html.indexOf("Done</button>");
  assert.ok(cancelAt > 0 && doneAt > cancelAt, "Cancel then Done, as in the mockup");
  assert.match(html, /aria-keyshortcuts="Escape"/);
  assert.match(html, /aria-keyshortcuts="Enter"/);
  assert.doesNotMatch(html, /disabled/);
  const finishing = renderToStaticMarkup(createElement(RecordingPanel, { recorder: fakeRecorder({ phase: "finishing" }) }));
  assert.equal(finishing.match(/disabled=""/g)?.length, 2, "both buttons wait while the recording closes");
});

test("Enter finishes and Esc cancels from the panel; Enter on a button is left to the button", () => {
  class FakeButton {}
  globals.HTMLButtonElement = FakeButton;
  const recorder = fakeRecorder();
  const panel = RecordingPanel({ recorder }) as AnyElement;
  const onKeyDown = panel.props.onKeyDown as (event: unknown) => void;
  let prevented = 0;
  const press = (key: string, target: object) => onKeyDown({ key, target, preventDefault: () => (prevented += 1) });

  press("Enter", {});
  press("Escape", new FakeButton());
  press("Enter", new FakeButton());
  press("Tab", {});
  assert.deepEqual(recorder.calls, ["finish", "cancel"]);
  assert.equal(prevented, 2);

  const buttons = elements(panel).filter((element) => element.type === "button");
  const [cancel, done] = buttons;
  assert.equal(buttons.length, 2);
  (cancel?.props.onClick as () => void)();
  (done?.props.onClick as () => void)();
  assert.deepEqual(recorder.calls, ["finish", "cancel", "cancel", "finish"]);
  assert.equal(done?.props.ref, recorder.doneButton, "Done is the button that receives focus");
});

// --- Composer markup per state ---

test("idle composer: plain text box, Send disabled until there is text, no Stop anywhere", () => {
  const empty = renderPanel();
  assert.match(empty, /<div class="composer-field"><textarea/);
  assert.match(sendButton(empty), /disabled=""[^>]*>Send<\/button>$/);
  assert.doesNotMatch(sendButton(empty), /aria-label/);
  assert.doesNotMatch(empty, /stop-btn/);
  const typed = renderPanel({ input: "A storm" });
  assert.doesNotMatch(sendButton(typed), /disabled/);
  assert.match(sendButton(typed), />Send<\/button>$/);
  assert.match(note(empty), /^<p class="muted composer-note" role="status"><\/p>$/, "the live region is always present");
});

test("while a reply runs the busy line has no Stop and Send turns into an enabled Stop", () => {
  const html = renderPanel({ busy: true, input: "" });
  assert.match(html, /<p class="muted chat-busy" role="status">The creative director is thinking…<\/p>/);
  assert.doesNotMatch(html, /stop-btn/);
  assert.doesNotMatch(html, /stop-row/);
  const button = sendButton(html);
  assert.match(button, new RegExp(`aria-label="${STOP_LABEL}"`));
  assert.doesNotMatch(button, /disabled/);
  assert.match(button, />Stop<\/button>$/);
});

test("turning voice into text happens inside the composer, over the kept draft, stopped by the Send→Stop button", () => {
  const html = renderPanel({ transcribing: true, input: "My draft" });
  const field = composerField(html);
  assert.match(field, /^<div class="composer-field is-covered">/);
  assert.match(field, />My draft<\/textarea>/, "the draft is kept underneath");
  assert.match(field, /<div class="voice-panel voice-panel-busy"><span class="voice-shimmer" aria-hidden="true">/);
  assert.match(field, new RegExp(`<span class="voice-spinner" aria-hidden="true"></span>${TRANSCRIBING_TEXT}`));
  assert.doesNotMatch(field, /<button/, "no extra Stop inside the panel");
  assert.equal(html.split(TRANSCRIBING_TEXT).length - 1, 2, "once in the panel, once for screen readers only");
  assert.match(note(html), new RegExp(`is-reserved" role="status"><span class="sr-only">${TRANSCRIBING_TEXT}</span></p>$`));
  assert.doesNotMatch(html, /stop-row/, "no separate busy line under the composer for voice");
  assert.match(sendButton(html), />Stop<\/button>$/);
  assert.doesNotMatch(sendButton(html), /disabled/);
  assert.match(attachButton(html), /disabled=""/);
});

test("uploads keep their status line and use the same Send→Stop button", () => {
  const html = renderPanel({ uploading: "document", input: "draft" });
  assert.match(html, /<div class="stop-row"><p class="muted" role="status">Reading document…<\/p><\/div>/);
  assert.doesNotMatch(html, /stop-btn/);
  assert.match(sendButton(html), new RegExp(`aria-label="${STOP_LABEL}"`));
  assert.match(attachButton(html), /disabled=""/);
});

test("a voice error shows in the composer with Try again and Dismiss, and the draft stays", () => {
  const message = "Gemini is busy right now — try again in a minute.";
  const html = renderPanel({ micError: message, input: "Keep me" });
  assert.match(html, /<div class="composer-field"><textarea[^>]*>Keep me<\/textarea><\/div><div class="voice-problem">/);
  assert.match(html, new RegExp(`<p class="error voice-problem-text" role="alert">${message}</p>`));
  assert.match(html, />Try again<\/button>/);
  assert.match(html, />Dismiss<\/button>/);
  const upload = renderPanel({ voiceError: "Choose a TXT or PDF story." });
  assert.doesNotMatch(upload, /voice-problem/, "file errors keep their own line");
  assert.match(upload, /<p class="error" role="alert">Choose a TXT or PDF story.<\/p>/);
});

test("after a voice transcript the box flashes briefly and the helper line asks to check, then Send", () => {
  const html = renderPanel({ voiceAdded: 1, input: "Aswin walks through the dark forest at stormy dusk." });
  const field = composerField(html);
  assert.match(field, /^<div class="composer-field">/, "the text box is uncovered");
  assert.match(field, /<span class="composer-flash" aria-hidden="true"><\/span>/);
  assert.match(
    note(html),
    new RegExp(`<span class="composer-note-check" aria-hidden="true">✓ </span>${TRANSCRIBED_HELPER}</p>$`),
  );
  assert.doesNotMatch(renderPanel({ voiceAdded: 0, input: "x" }), /composer-flash|From your voice/);
});
