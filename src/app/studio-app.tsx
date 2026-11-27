"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ExportMenu } from "@/app/export-menu";
import { ConversationPanel, type UploadingKind } from "./conversation-panel";
import { SettingsScreen, type SettingsSection } from "./settings-screen";
import { Sidebar } from "./sidebar";
import { StoryEditor } from "./story-editor";
import { validateAudioFile } from "@/lib/audio";
import { buildDecisionHistory } from "@/lib/decisions";
import type { ResolvedInterviewTurn } from "@/lib/interview";
import { answerFor } from "@/lib/quick-actions";
import { MAX_SESSION_TITLE, newId, planSignature, type ChatMessage, type StorySession } from "@/lib/session";
import { checkSourceText, needsDigest, type SourceKind, type StorySource, storyForStep } from "@/lib/source-text";
import {
  approveFact,
  contextReadiness,
  detectDiscoveryCommand,
  EMPTY_CONTEXT,
  removeFact,
  type StoryContext,
} from "@/lib/story-context";
import { MAX_ANSWER_CHARACTERS, MAX_CHAT_HISTORY, MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/story-input";
import type { ShotPlan } from "@/lib/story-planning";
import {
  analyzeImage,
  askDirector,
  askInterview,
  createDigest,
  directorCollected,
  generatePlan,
  importDocument,
  MAX_REFERENCES,
  transcribeVoice,
} from "@/lib/studio-agent";
import { classifyUpload, documentExtensionOf, routeLongText, sourceNote, tooLongForChatMessage } from "@/lib/upload";
import { useSessions } from "@/lib/use-sessions";
import { useTokenBudget } from "@/lib/use-token-budget";
import type { UsageRecord } from "@/lib/usage";

export function StudioApp() {
  const store = useSessions();
  const { budget, setBudget } = useTokenBudget();
  const { active } = store;

  const [view, setView] = useState<"chat" | "settings">("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("usage");
  const [creating, setCreating] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [input, setInput] = useState("");
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [uploading, setUploading] = useState<UploadingKind | null>(null);
  const [busyNote, setBusyNote] = useState<{ id: string; text: string } | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeIdRef = useRef<string | null>(store.activeId);
  const sessionsRef = useRef<StorySession[]>(store.sessions);
  const requestIdRef = useRef(0);
  const busy = busySessionId === store.activeId;

  activeIdRef.current = store.activeId;
  sessionsRef.current = store.sessions;

  function beginRequest(id: string) {
    const requestId = ++requestIdRef.current;
    setBusySessionId(id);
    if (activeIdRef.current === id) setError("");
    return requestId;
  }

  function finishRequest(requestId: number) {
    if (requestId === requestIdRef.current) setBusySessionId(null);
  }

  function isActiveRequestSession(id: string) {
    return activeIdRef.current === id;
  }

  function sessionById(id: string): StorySession | undefined {
    return sessionsRef.current.find((session) => session.id === id);
  }

  function clearBusyNote(id: string) {
    setBusyNote((current) => (current?.id === id ? null : current));
  }

  // Open the sidebar by default on desktop; keep it closed (drawer) on small screens.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 961px)").matches) {
      setSidebarOpen(true);
    }
  }, []);

  // The sidebar is a drawer only on small screens; on desktop it stays open after navigation.
  const closeDrawer = useCallback(() => {
    if (window.matchMedia("(max-width: 960px)").matches) setSidebarOpen(false);
  }, []);

  // Reset the transient compose state whenever the active session changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the active id only.
  useEffect(() => {
    setInput("");
    setError("");
    setVoiceError("");
  }, [store.activeId]);

  const recordUsage = useCallback(
    (id: string, usage?: UsageRecord | UsageRecord[]) => {
      const records = Array.isArray(usage) ? usage : usage ? [usage] : [];
      if (records.length === 0) return;
      store.update(id, (session) => ({ ...session, usage: [...session.usage, ...records] }));
    },
    [store],
  );

  const applyInterviewTurn = useCallback(
    (id: string, turn: ResolvedInterviewTurn, usage?: UsageRecord, context?: StoryContext) => {
      store.update(id, (base) => {
        const session = context ? { ...base, context } : base;
        if (turn.status === "ask") {
          const question: ChatMessage = {
            id: newId(),
            role: "agent",
            text: [turn.note.trim(), turn.question].filter(Boolean).join("\n\n") || turn.question,
            suggestion: turn.rationale || undefined,
          };
          return {
            ...session,
            collected: turn.collected,
            pendingQuestion: turn.question,
            readyToPlan: false,
            messages: [...session.messages, question],
          };
        }
        const message: ChatMessage = {
          id: newId(),
          role: "agent",
          text: turn.note.trim() || "I think we have enough to plan the shots.",
          suggestion: turn.recommendation || undefined,
        };
        return {
          ...session,
          collected: turn.collected,
          pendingQuestion: null,
          readyToPlan: true,
          messages: [...session.messages, message],
        };
      });
      recordUsage(id, usage);
    },
    [store, recordUsage],
  );

  async function openConversation(id: string, title: string, source?: StorySource) {
    const story = storyForStep(title, source, "interview");
    if (!story.ok) {
      if (isActiveRequestSession(id)) setError(story.error);
      return;
    }
    const requestId = beginRequest(id);
    const result = await askInterview(story.story, []);
    finishRequest(requestId);
    if (!result.ok) {
      if (isActiveRequestSession(id)) setError(result.error);
      return;
    }
    applyInterviewTurn(id, result.turn, result.usage, result.context);
  }

  function submitTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = titleDraft.trim();
    if (!title) return;
    const id = store.create(title);
    setCreating(false);
    setTitleDraft("");
    setView("chat");
    closeDrawer();
    void openConversation(id, title);
  }

  async function sendDiscovery(session: StorySession, text: string, fromComposer = true) {
    const command = detectDiscoveryCommand(text);
    const toPlan = command === "stop" || (session.readyToPlan && !session.pendingQuestion);
    const story = storyForStep(session.title, session.source, toPlan ? "plan" : "interview");
    if (!story.ok) {
      setError(story.error);
      return;
    }
    if (command === "stop") {
      const stopMessage: ChatMessage = { id: newId(), role: "user", text };
      store.update(session.id, (current) => ({ ...current, messages: [...current.messages, stopMessage] }));
      if (fromComposer) setInput("");
      await createPlan(session, stopMessage, fromComposer ? text : "");
      return;
    }
    if (session.readyToPlan && !session.pendingQuestion) {
      const userMessage: ChatMessage = { id: newId(), role: "user", text };
      const nextAnswered = [...session.answered, { question: "Additional direction", answer: text }];
      store.update(session.id, (current) => ({
        ...current,
        messages: [...current.messages, userMessage],
        answered: nextAnswered,
      }));
      if (fromComposer) setInput("");
      await createPlan({ ...session, answered: nextAnswered }, undefined, fromComposer ? text : "");
      return;
    }
    const answer = answerFor(command, text);
    const userMessage: ChatMessage = {
      id: newId(),
      role: "user",
      text,
      answerIndex: session.pendingQuestion ? session.answered.length : undefined,
    };
    const nextAnswered = session.pendingQuestion
      ? [...session.answered, { question: session.pendingQuestion, answer }]
      : session.answered;
    store.update(session.id, (current) => ({
      ...current,
      messages: [...current.messages, userMessage],
      answered: nextAnswered,
      pendingQuestion: null,
    }));
    if (fromComposer) setInput("");
    const requestId = beginRequest(session.id);

    const result = await askInterview(story.story, nextAnswered, session.context);
    finishRequest(requestId);
    if (!result.ok) {
      store.update(session.id, (current) => ({
        ...current,
        messages: current.messages.filter((message) => message.id !== userMessage.id),
        answered: session.answered,
        pendingQuestion: session.pendingQuestion,
      }));
      if (fromComposer && isActiveRequestSession(session.id)) setInput((previous) => previous || text);
      if (isActiveRequestSession(session.id)) setError(result.error);
      return;
    }
    applyInterviewTurn(session.id, result.turn, result.usage, result.context);
  }

  async function sendRefine(session: StorySession, text: string, fromComposer = true) {
    if (!session.plan) return;
    const baseSignature = planSignature(session.plan);
    const userMessage: ChatMessage = { id: newId(), role: "user", text };
    const history = session.messages
      .slice(-MAX_CHAT_HISTORY)
      .map((message) => ({ role: message.role, text: message.text }));
    store.update(session.id, (current) => ({ ...current, messages: [...current.messages, userMessage] }));
    if (fromComposer) setInput("");
    const requestId = beginRequest(session.id);

    const result = await askDirector({
      plan: session.plan,
      messages: history,
      message: text,
      answers: session.answered,
      collected: directorCollected(session.context, session.collected),
      references: session.references?.length ? session.references : undefined,
      context: session.context,
      decisions: buildDecisionHistory(session.messages),
    });
    finishRequest(requestId);
    if (!result.ok) {
      store.update(session.id, (current) => ({
        ...current,
        messages: current.messages.filter((message) => message.id !== userMessage.id),
      }));
      if (fromComposer && isActiveRequestSession(session.id)) setInput((previous) => previous || text);
      if (isActiveRequestSession(session.id)) setError(result.error);
      return;
    }
    const { response } = result;
    const agentMessage: ChatMessage = {
      id: newId(),
      role: "agent",
      text: response.reply,
      specialists: response.specialists.length > 0 ? response.specialists : undefined,
      failedSpecialists: response.failed.length > 0 ? response.failed : undefined,
      recommendations: response.recommendations.length > 0 ? response.recommendations : undefined,
      conflicts: response.conflicts.length > 0 ? response.conflicts : undefined,
      ...(response.plan
        ? { changeSummary: response.changeSummary, proposedPlan: response.plan, status: "pending" as const, baseSignature }
        : {}),
    };
    store.update(session.id, (current) => ({
      ...current,
      messages: [...current.messages, agentMessage],
      usage: [...current.usage, ...response.usage],
    }));
  }

  function send() {
    if (!active || busy || transcribing) return;
    const text = input.trim();
    if (!text) return;
    const limit = active.phase === "discovery" ? MAX_ANSWER_CHARACTERS : MAX_CHAT_MESSAGE_CHARACTERS;
    if (text.length > limit) {
      setError(
        `This message is ${text.length.toLocaleString("en")} characters; one message can hold ${limit.toLocaleString("en")}. Shorten it before sending.`,
      );
      return;
    }
    if (active.phase === "discovery") void sendDiscovery(active, text);
    else void sendRefine(active, text);
  }

  function sendDiscoveryAction(label: string) {
    if (!active || busy || transcribing || uploading || active.phase !== "discovery") return;
    void sendDiscovery(active, label, false);
  }

  function sendQuickAction(message: string) {
    if (!active || busy || transcribing || uploading || active.phase !== "refining") return;
    void sendRefine(active, message, false);
  }

  async function createPlan(session: StorySession, trigger?: ChatMessage, draft = "") {
    const fail = (message: string) => {
      if (trigger) {
        store.update(session.id, (current) => ({
          ...current,
          messages: current.messages.filter((item) => item.id !== trigger.id),
        }));
      }
      if (draft && isActiveRequestSession(session.id)) setInput((previous) => previous || draft);
      if (isActiveRequestSession(session.id)) setError(message);
    };
    const story = storyForStep(session.title, session.source, "plan");
    if (!story.ok) {
      fail(story.error);
      return;
    }
    const requestId = beginRequest(session.id);
    const result = await generatePlan(story.story, session.answered, session.collected, session.context);
    finishRequest(requestId);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    const message: ChatMessage = {
      id: newId(),
      role: "agent",
      text: "Your shot plan is ready on the right. Tell me what to change, or tap a button below for expert advice. Nothing changes until you press Apply.",
    };
    store.update(session.id, (current) => ({
      ...current,
      plan: result.plan,
      phase: "refining",
      readyToPlan: false,
      pendingQuestion: null,
      messages: [...current.messages, message],
    }));
    recordUsage(session.id, result.usage);
  }

  function doGeneratePlan() {
    if (!active || busy) return;
    void createPlan(active);
  }

  function acceptProposal(message: ChatMessage) {
    if (!active || !message.proposedPlan) return;
    if (
      message.baseSignature &&
      planSignature(active.plan) !== message.baseSignature &&
      !window.confirm("The story changed after you asked for this suggestion. Applying it will replace those changes. Apply anyway?")
    ) {
      return;
    }
    const plan = message.proposedPlan;
    store.update(active.id, (current) => ({
      ...current,
      plan,
      messages: current.messages.map((item) =>
        item.id === message.id ? { ...item, status: "accepted", proposedPlan: undefined } : item,
      ),
    }));
  }

  function editAnswer(messageId: string, value: string): boolean {
    if (!active || busy || active.phase !== "discovery") return false;
    const text = value.trim().slice(0, MAX_ANSWER_CHARACTERS);
    if (!text) return false;
    const index = active.messages.find((message) => message.id === messageId)?.answerIndex;
    if (index === undefined || !active.answered[index]) return false;
    const answer = answerFor(detectDiscoveryCommand(text), text);
    store.update(active.id, (current) => ({
      ...current,
      answered: current.answered.map((item, position) => (position === index ? { ...item, answer } : item)),
      messages: current.messages.map((message) => (message.id === messageId ? { ...message, text } : message)),
    }));
    return true;
  }

  function rejectProposal(id: string) {
    if (!active) return;
    store.update(active.id, (current) => ({
      ...current,
      messages: current.messages.map((item) =>
        item.id === id ? { ...item, status: "rejected", proposedPlan: undefined } : item,
      ),
    }));
  }

  function updateContext(change: (context: StoryContext) => StoryContext) {
    if (!active || busy) return;
    store.update(active.id, (current) => (current.context ? { ...current, context: change(current.context) } : current));
  }

  function editPlan(mutate: (plan: ShotPlan) => void) {
    if (!active) return;
    store.update(active.id, (current) => {
      if (!current.plan) return current;
      const next = structuredClone(current.plan);
      mutate(next);
      return { ...current, plan: next };
    });
  }

  async function adoptSource(id: string, imported: StorySource) {
    const replaced = sessionById(id)?.source?.name;
    let source = imported;
    let digestFailed = false;
    const requestId = beginRequest(id);
    store.update(id, (current) => ({ ...current, source }));
    if (needsDigest(source)) {
      setBusyNote({ id, text: "Making a condensed version of your long story…" });
      const digest = await createDigest(source.name, source.text);
      if (digest.ok) {
        source = { ...source, digest: digest.digest };
        recordUsage(id, digest.usage);
      } else {
        digestFailed = true;
        if (isActiveRequestSession(id)) {
          setError(`${digest.error} The story is saved, but questions can't use it until you import it again.`);
        }
      }
    }
    const note: ChatMessage = { id: newId(), role: "agent", text: sourceNote(source, { replaced, digestFailed }) };
    store.update(id, (current) => ({ ...current, source, messages: [...current.messages, note] }));
    const session = sessionById(id);
    const story = storyForStep(session?.title ?? "", source, "interview");
    if (digestFailed || !session || !story.ok) {
      clearBusyNote(id);
      finishRequest(requestId);
      if (!story.ok && !digestFailed && isActiveRequestSession(id)) setError(story.error);
      return;
    }
    setBusyNote({ id, text: "Reading your story for what's still missing…" });
    const result = await askInterview(story.story, session.answered, session.context);
    clearBusyNote(id);
    finishRequest(requestId);
    if (!result.ok) {
      if (isActiveRequestSession(id)) setError(result.error);
      return;
    }
    applyInterviewTurn(id, result.turn, result.usage, result.context);
  }

  async function placeImportedText(
    id: string,
    text: string,
    origin: "document" | "transcript",
    meta: { name: string; kind: SourceKind; characters: number; pages?: number },
  ) {
    const session = sessionById(id);
    if (!session) return;
    const phase = session.phase === "refining" && session.plan ? "refining" : "discovery";
    const composerLimit = phase === "discovery" ? MAX_ANSWER_CHARACTERS : MAX_CHAT_MESSAGE_CHARACTERS;
    const route = routeLongText({ chars: meta.characters, origin, phase, composerLimit });
    if (route === "too-long-for-chat") {
      if (isActiveRequestSession(id)) setVoiceError(tooLongForChatMessage(meta.characters));
      return;
    }
    if (route === "composer") {
      if (!isActiveRequestSession(id)) return;
      const separator = origin === "document" ? "\n\n" : " ";
      setInput((current) => (current.trim() ? `${current.trim()}${separator}${text}` : text));
      return;
    }
    await adoptSource(id, { ...meta, text });
  }

  async function transcribeInto(file: File, name: string, mode: "mic" | "upload") {
    if (!active) return;
    const id = active.id;
    if (mode === "mic") setTranscribing(true);
    else setUploading("audio");
    setVoiceError("");
    const result = await transcribeVoice(file);
    if (mode === "mic") setTranscribing(false);
    else setUploading(null);
    if (!result.ok) {
      if (isActiveRequestSession(id)) setVoiceError(result.error);
      return;
    }
    recordUsage(id, result.usage);
    const checked = checkSourceText(result.text, `“${name}”`);
    if (!checked.ok) {
      if (isActiveRequestSession(id)) setVoiceError(checked.error);
      return;
    }
    await placeImportedText(id, checked.text, "transcript", { name, kind: "audio", characters: checked.text.length });
  }

  function handleVoice(file: File) {
    void transcribeInto(file, "Voice note", "mic");
  }

  async function handleImage(file: File) {
    if (!active) return;
    const id = active.id;
    setUploading("image");
    setVoiceError("");
    const result = await analyzeImage(file);
    setUploading(null);
    if (!result.ok) {
      setVoiceError(result.error);
      return;
    }
    const { reference, usage } = result;
    const message: ChatMessage = { id: newId(), role: "agent", text: reference.summary, reference };
    store.update(id, (current) => ({
      ...current,
      references: [...(current.references ?? []), reference].slice(-MAX_REFERENCES),
      messages: [...current.messages, message],
      usage: [...current.usage, usage],
    }));
  }

  async function handleUpload(file: File) {
    if (!active) return;
    const kind = classifyUpload(file);
    if (typeof kind !== "string") {
      setVoiceError(kind.error);
      return;
    }
    if (kind === "image") {
      await handleImage(file);
      return;
    }
    if (kind === "audio") {
      const check = validateAudioFile(file);
      if (!check.ok) {
        setVoiceError(check.error);
        return;
      }
      await transcribeInto(file, file.name, "upload");
      return;
    }
    const id = active.id;
    setUploading("document");
    setVoiceError("");
    const result = await importDocument(file);
    setUploading(null);
    if (!result.ok) {
      if (isActiveRequestSession(id)) setVoiceError(result.error);
      return;
    }
    await placeImportedText(id, result.text, "document", {
      name: file.name,
      kind: documentExtensionOf(file.name) ?? "txt",
      characters: result.characters,
      pages: result.pages,
    });
  }

  function startNewChat() {
    setCreating(true);
    setTitleDraft("");
    setView("chat");
    setError("");
    closeDrawer();
  }

  function selectSession(id: string) {
    store.select(id);
    setCreating(false);
    setView("chat");
    closeDrawer();
  }

  function deleteSession(id: string) {
    const target = store.sessions.find((session) => session.id === id);
    if (!target) return;
    if (window.confirm(`Delete “${target.title}”? This cannot be undone.`)) {
      store.remove(id);
    }
  }

  const showTitlePrompt = view === "chat" && (creating || (store.hydrated && !active));

  if (view === "settings") {
    return (
      <SettingsScreen
        section={settingsSection}
        sessions={store.sessions}
        budget={budget}
        onSection={setSettingsSection}
        onBudgetChange={setBudget}
        onClearAll={store.clearAll}
        onBack={() => setView("chat")}
      />
    );
  }

  return (
    <div className={`app-shell${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      {sidebarOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close is a convenience; all controls remain keyboard-reachable.
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is a non-essential overlay duplicate of the close button.
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}
      <Sidebar
        sessions={store.sessions}
        activeId={creating ? null : store.activeId}
        view={view}
        open={sidebarOpen}
        onNewChat={startNewChat}
        onSelect={selectSession}
        onRename={store.rename}
        onDelete={deleteSession}
        onNav={(next) => {
          setSettingsSection(next === "usage" ? "usage" : "preferences");
          setView("settings");
          closeDrawer();
        }}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="app-main">
        <div className="app-topbar">
          {!sidebarOpen && (
            <button
              className="app-menu"
              type="button"
              aria-label="Show sidebar"
              aria-expanded={false}
              onClick={() => setSidebarOpen(true)}
            >
              ☰
            </button>
          )}
          <span className="app-topbar-title">
            {creating ? "New project" : active?.title ?? "Story Studio"}
          </span>
          {!creating && active && <ExportMenu session={active} />}
        </div>

        {store.storageWarning && (
          <p className="error app-storage-warning" role="alert">
            {store.storageWarning}
          </p>
        )}

        {!store.hydrated ? (
          <p className="muted app-loading">Loading your sessions…</p>
        ) : showTitlePrompt ? (
          <section className="new-chat" aria-labelledby="new-chat-title">
            <h2 className="studio-title" id="new-chat-title">
              Start a new project
            </h2>
            <form className="new-chat-form" onSubmit={submitTitle}>
              <label className="editor-field-label" htmlFor="new-chat-input">
                Title
              </label>
              <input
                id="new-chat-input"
                className="editor-input"
                type="text"
                value={titleDraft}
                maxLength={MAX_SESSION_TITLE}
                placeholder="e.g. The Lighthouse Keeper"
                onChange={(event) => setTitleDraft(event.target.value)}
              />
              <button className="button" type="submit" disabled={!titleDraft.trim()}>
                Create project
              </button>
            </form>
            <p className="muted new-chat-hint">
              That’s all we need to start. We’ll ask about the rest, one question at a time.
            </p>
          </section>
        ) : active ? (
          <div className="workspace-grid">
            <ConversationPanel
              session={active}
              busy={busy}
              error={error}
              input={input}
              transcribing={transcribing}
              voiceError={voiceError}
              canGeneratePlan={
                active.phase === "discovery" &&
                (active.answered.length >= 1 || contextReadiness(active.context ?? EMPTY_CONTEXT).ready)
              }
              uploading={uploading}
              busyText={busyNote?.id === active.id ? busyNote.text : undefined}
              onInput={setInput}
              onSend={send}
              onQuickAction={sendQuickAction}
              onDiscoveryAction={sendDiscoveryAction}
              onGeneratePlan={doGeneratePlan}
              onAccept={acceptProposal}
              onReject={rejectProposal}
              onEditAnswer={editAnswer}
              onVoice={handleVoice}
              onVoiceActive={() => {}}
              onUpload={handleUpload}
              onRetry={() => void openConversation(active.id, active.title, active.source)}
            />
            <StoryEditor
              session={active}
              busy={busy}
              onEditPlan={editPlan}
              onApproveFact={(key) => updateContext((context) => approveFact(context, key))}
              onRemoveFact={(key) => updateContext((context) => removeFact(context, key))}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
