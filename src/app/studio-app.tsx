"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ConversationPanel } from "./conversation-panel";
import { SettingsScreen, type SettingsSection } from "./settings-screen";
import { Sidebar } from "./sidebar";
import { StoryEditor } from "./story-editor";
import type { ResolvedInterviewTurn } from "@/lib/interview";
import { MAX_SESSION_TITLE, newId, planSignature, type ChatMessage, type StorySession } from "@/lib/session";
import { MAX_ANSWER_CHARACTERS, MAX_CHAT_HISTORY, MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/story-input";
import type { ShotPlan } from "@/lib/story-planning";
import { askDirector, askInterview, generatePlan, importDocument, transcribeVoice } from "@/lib/studio-agent";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    (id: string, turn: ResolvedInterviewTurn, usage?: UsageRecord) => {
      store.update(id, (session) => {
        if (turn.status === "ask") {
          const question: ChatMessage = {
            id: newId(),
            role: "agent",
            text: [turn.note, turn.question].filter(Boolean).join("\n\n") || turn.question,
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
          text: turn.note || "I think we have enough to plan the shots.",
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

  const openConversation = useCallback(
    async (id: string, title: string) => {
      setBusy(true);
      setError("");
      const result = await askInterview(title, []);
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      applyInterviewTurn(id, result.turn, result.usage);
    },
    [applyInterviewTurn],
  );

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

  async function sendDiscovery(session: StorySession, text: string) {
    const userMessage: ChatMessage = {
      id: newId(),
      role: "user",
      text,
      answerIndex: session.pendingQuestion ? session.answered.length : undefined,
    };
    const nextAnswered = session.pendingQuestion
      ? [...session.answered, { question: session.pendingQuestion, answer: text }]
      : session.answered;
    store.update(session.id, (current) => ({
      ...current,
      messages: [...current.messages, userMessage],
      answered: nextAnswered,
      pendingQuestion: null,
    }));
    setInput("");
    setBusy(true);
    setError("");

    const result = await askInterview(session.title, nextAnswered);
    setBusy(false);
    if (!result.ok) {
      store.update(session.id, (current) => ({
        ...current,
        messages: current.messages.filter((message) => message.id !== userMessage.id),
        answered: session.answered,
        pendingQuestion: session.pendingQuestion,
      }));
      setInput((previous) => previous || text);
      setError(result.error);
      return;
    }
    applyInterviewTurn(session.id, result.turn, result.usage);
  }

  async function sendRefine(session: StorySession, text: string) {
    if (!session.plan) return;
    const baseSignature = planSignature(session.plan);
    const userMessage: ChatMessage = { id: newId(), role: "user", text };
    const history = session.messages
      .slice(-MAX_CHAT_HISTORY)
      .map((message) => ({ role: message.role, text: message.text }));
    store.update(session.id, (current) => ({ ...current, messages: [...current.messages, userMessage] }));
    setInput("");
    setBusy(true);
    setError("");

    const result = await askDirector({
      plan: session.plan,
      messages: history,
      message: text,
      answers: session.answered,
      collected: session.collected,
    });
    setBusy(false);
    if (!result.ok) {
      store.update(session.id, (current) => ({
        ...current,
        messages: current.messages.filter((message) => message.id !== userMessage.id),
      }));
      setInput((previous) => previous || text);
      setError(result.error);
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
    if (active.phase === "discovery") void sendDiscovery(active, text.slice(0, MAX_ANSWER_CHARACTERS));
    else void sendRefine(active, text.slice(0, MAX_CHAT_MESSAGE_CHARACTERS));
  }

  async function doGeneratePlan() {
    if (!active || busy) return;
    if (active.answered.length < 1) {
      setError("Answer at least one question before generating the plan.");
      return;
    }
    setBusy(true);
    setError("");
    const result = await generatePlan(active.title, active.answered, active.collected);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const message: ChatMessage = {
      id: newId(),
      role: "agent",
      text: "I’ve drafted a full shot plan — it’s in the editor on the right. Tell me what to change and I’ll propose edits for your approval.",
    };
    store.update(active.id, (current) => ({
      ...current,
      plan: result.plan,
      phase: "refining",
      readyToPlan: false,
      pendingQuestion: null,
      messages: [...current.messages, message],
    }));
    recordUsage(active.id, result.usage);
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
    store.update(active.id, (current) => ({
      ...current,
      answered: current.answered.map((item, position) => (position === index ? { ...item, answer: text } : item)),
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

  function editPlan(mutate: (plan: ShotPlan) => void) {
    if (!active) return;
    store.update(active.id, (current) => {
      if (!current.plan) return current;
      const next = structuredClone(current.plan);
      mutate(next);
      return { ...current, plan: next };
    });
  }

  async function handleVoice(file: File) {
    if (!active) return;
    setTranscribing(true);
    setVoiceError("");
    const result = await transcribeVoice(file);
    setTranscribing(false);
    if (!result.ok) {
      setVoiceError(result.error);
      return;
    }
    recordUsage(active.id, result.usage);
    setInput((current) => (current.trim() ? `${current.trim()} ${result.text}` : result.text));
  }

  async function handleUpload(file: File) {
    if (!active) return;
    setUploading(true);
    setVoiceError("");
    const result = await importDocument(file);
    setUploading(false);
    if (!result.ok) {
      setVoiceError(result.error);
      return;
    }
    const limit = active.phase === "discovery" ? MAX_ANSWER_CHARACTERS : MAX_CHAT_MESSAGE_CHARACTERS;
    const text = result.text.slice(0, limit);
    setInput((current) => (current.trim() ? `${current.trim()}\n\n${text}` : text));
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
        activeId={store.activeId}
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
          <span className="app-topbar-title">{active?.title ?? "Story Studio"}</span>
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
                What is your project title?
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
              That’s all we need to start. The creative director will ask about the genre, characters, scenes and
              everything else as you chat — one question at a time.
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
              canGeneratePlan={active.phase === "discovery" && active.answered.length >= 1}
              uploading={uploading}
              onInput={setInput}
              onSend={send}
              onGeneratePlan={doGeneratePlan}
              onAccept={acceptProposal}
              onReject={rejectProposal}
              onEditAnswer={editAnswer}
              onVoice={handleVoice}
              onVoiceActive={() => {}}
              onUpload={handleUpload}
              onRetry={() => void openConversation(active.id, active.title)}
            />
            <StoryEditor session={active} onEditPlan={editPlan} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
