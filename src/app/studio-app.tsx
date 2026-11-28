"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ExportMenu } from "@/app/export-menu";
import { ConversationPanel, type UploadingKind } from "./conversation-panel";
import { EngagementPanel } from "./engagement-report";
import { OriginalityPanel } from "./originality-report";
import { ReportConfirmDialog } from "./report-confirm-dialog";
import { SettingsScreen, type SettingsSection } from "./settings-screen";
import { Sidebar } from "./sidebar";
import { StoryEditor } from "./story-editor";
import { StoryIdeas } from "./story-ideas";
import { validateAudioFile } from "@/lib/audio";
import { buildDecisionHistory } from "@/lib/decisions";
import { conceptProjectTitle, conceptSource, seedContextFromConcept, type StoryConcept } from "@/lib/ideas";
import { sessionFromConcept } from "@/lib/ideas-flow";
import { addVisualLook } from "@/lib/look-and-feel";
import type { EngagementRecommendation, RecommendationAction } from "@/lib/engagement";
import { recommendationRequest } from "@/lib/engagement-ui";
import { addExtraDirection } from "@/lib/interview";
import type { OriginalityFinding } from "@/lib/originality";
import { type FindingAction, findingActionMessage } from "@/lib/originality-ui";
import {
  answerFor,
  type ReportId,
  showEngagementAction,
  showOriginalityAction,
  showReportAction,
} from "@/lib/quick-actions";
import { REPORT_CONFIRM_COPY, reportEntry, runConfirmedReport } from "@/lib/report-confirm";
import { rollbackTurn, STOPPED_IMPORT_MESSAGE, STOPPED_MESSAGE, stoppedNotice } from "@/lib/request-stop";
import { MAX_SESSION_TITLE, newId, planSignature, type ChatMessage, type StorySession } from "@/lib/session";
import { checkSourceText, needsDigest, type SourceKind, type StorySource, storyForStep } from "@/lib/source-text";
import {
  approveFact,
  contextReadiness,
  detectDiscoveryCommand,
  EMPTY_CONTEXT,
  editFact,
  removeFact,
  type StoryContext,
} from "@/lib/story-context";
import { MAX_ANSWER_CHARACTERS, MAX_CHAT_HISTORY, MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/story-input";
import type { ShotPlan } from "@/lib/story-planning";
import {
  adoptReturnedContext,
  analyzeImage,
  askDirector,
  askInterview,
  checkEngagement,
  checkOriginality,
  createDigest,
  directorCollected,
  directorSource,
  generatePlan,
  importDocument,
  type InterviewReply,
  MAX_REFERENCES,
  transcribeVoice,
  withDismissedFinding,
  withEditedAnswer,
  withEngagementReport,
  withOriginalityReport,
  withRestoredFinding,
  withSessionContext,
} from "@/lib/studio-agent";
import { transcribeHintFor } from "@/lib/transcription";
import {
  appendToDraft,
  classifyUpload,
  documentExtensionOf,
  routeLongText,
  sourceNote,
  tooLongForChatMessage,
} from "@/lib/upload";
import { useSessions } from "@/lib/use-sessions";
import { useTokenBudget } from "@/lib/use-token-budget";
import type { UsageRecord } from "@/lib/usage";
import { voiceAddedAfter } from "@/lib/voice-ui";

const COMPOSER_FIELD_ID = "conversation-input";

export function StudioApp() {
  const store = useSessions();
  const { budget, setBudget } = useTokenBudget();
  const { active } = store;

  const [view, setView] = useState<"chat" | "settings">("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("usage");
  const [creating, setCreating] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [input, setInput] = useState("");
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [uploading, setUploading] = useState<UploadingKind | null>(null);
  const [busyNote, setBusyNote] = useState<{ id: string; text: string } | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const [micError, setMicError] = useState("");
  const [voiceAdded, setVoiceAdded] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [openReport, setOpenReport] = useState<ReportId | null>(null);
  const [confirmReport, setConfirmReport] = useState<ReportId | null>(null);
  const [wikipediaLookup, setWikipediaLookup] = useState(true);
  const [originalityRun, setOriginalityRun] = useState<{ id: string; references: boolean } | null>(null);
  const [originalityError, setOriginalityError] = useState<{ id: string; text: string } | null>(null);
  const [engagementRunId, setEngagementRunId] = useState<string | null>(null);
  const [engagementError, setEngagementError] = useState<{ id: string; text: string } | null>(null);
  const [stopNotice, setStopNotice] = useState<{ id: string; text: string; report?: ReportId } | null>(null);
  const activeIdRef = useRef<string | null>(store.activeId);
  const sessionsRef = useRef<StorySession[]>(store.sessions);
  const inputValueRef = useRef(input);
  const requestIdRef = useRef(0);
  const requestControllersRef = useRef(new Map<number, AbortController>());
  const uploadControllersRef = useRef(new Set<AbortController>());
  const exploreButtonRef = useRef<HTMLButtonElement>(null);
  const refocusExploreRef = useRef(false);
  const micTranscriptionsRef = useRef(0);
  const [composerFocus, setComposerFocus] = useState(0);
  const busy = busySessionId === store.activeId;

  activeIdRef.current = store.activeId;
  sessionsRef.current = store.sessions;
  inputValueRef.current = input;

  function beginRequest(id: string) {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    requestControllersRef.current.set(requestId, controller);
    setBusySessionId(id);
    setStopNotice(null);
    if (activeIdRef.current === id) setError("");
    return { requestId, signal: controller.signal };
  }

  function finishRequest(requestId: number) {
    requestControllersRef.current.delete(requestId);
    if (requestId === requestIdRef.current) setBusySessionId(null);
  }

  function stopRequest() {
    requestControllersRef.current.get(requestIdRef.current)?.abort();
  }

  function beginUpload() {
    const controller = new AbortController();
    uploadControllersRef.current.add(controller);
    setStopNotice(null);
    return controller;
  }

  function finishUpload(controller: AbortController) {
    uploadControllersRef.current.delete(controller);
  }

  function stopUploads() {
    for (const controller of uploadControllersRef.current) controller.abort();
  }

  function showStopped(id: string, text: string, report?: ReportId) {
    setStopNotice(report ? { id, text, report } : { id, text });
  }

  /** Only refills an empty composer; true when it did. */
  function restoreDraft(id: string, draft: string): boolean {
    if (!draft || !isActiveRequestSession(id)) return false;
    const restored = !inputValueRef.current;
    setInput((previous) => previous || draft);
    return restored;
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
    setMicError("");
    setVoiceAdded((count) => voiceAddedAfter(count, "session"));
    setOpenReport(null);
    setConfirmReport(null);
    setStopNotice(null);
  }, [store.activeId]);

  useEffect(() => {
    if (!composerFocus) return;
    const field = document.getElementById(COMPOSER_FIELD_ID);
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollTop = field.scrollHeight;
  }, [composerFocus]);

  const recordUsage = useCallback(
    (id: string, usage?: UsageRecord | UsageRecord[]) => {
      const records = Array.isArray(usage) ? usage : usage ? [usage] : [];
      if (records.length === 0) return;
      store.update(id, (session) => ({ ...session, usage: [...session.usage, ...records] }));
    },
    [store],
  );

  const applyInterviewTurn = useCallback(
    (id: string, { turn, usage, context, options }: InterviewReply) => {
      store.update(id, (base) => {
        const session = context ? { ...base, context: adoptReturnedContext(base.context, context) } : base;
        if (turn.status === "ask") {
          const question: ChatMessage = {
            id: newId(),
            role: "agent",
            text: [turn.note.trim(), turn.question].filter(Boolean).join("\n\n") || turn.question,
            suggestion: turn.rationale || undefined,
            ...(options.length > 0 ? { options } : {}),
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

  useEffect(() => {
    if (exploring || !refocusExploreRef.current) return;
    refocusExploreRef.current = false;
    exploreButtonRef.current?.focus();
  }, [exploring]);

  async function openConversation(id: string, title: string, source?: StorySource, context?: StoryContext) {
    const story = storyForStep(title, source, "interview");
    if (!story.ok) {
      if (isActiveRequestSession(id)) setError(story.error);
      return;
    }
    const { requestId, signal } = beginRequest(id);
    const result = await askInterview(story.story, [], context, { signal });
    finishRequest(requestId);
    if (!result.ok) {
      if (result.stopped) showStopped(id, STOPPED_MESSAGE);
      else if (isActiveRequestSession(id)) setError(result.error);
      return;
    }
    applyInterviewTurn(id, result);
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

  function closeIdeas() {
    refocusExploreRef.current = true;
    setExploring(false);
  }

  function developConcept(concept: StoryConcept, usage: UsageRecord[]) {
    const title = conceptProjectTitle(concept);
    const id = store.create(title);
    store.update(id, (session) => sessionFromConcept(session, concept, usage));
    setExploring(false);
    setCreating(false);
    setTitleDraft("");
    setView("chat");
    closeDrawer();
    void openConversation(id, title, conceptSource(concept), seedContextFromConcept(concept));
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
      const nextAnswered = addExtraDirection(session.answered, text);
      store.update(session.id, (current) => ({
        ...current,
        messages: [...current.messages, userMessage],
        answered: nextAnswered,
      }));
      if (fromComposer) setInput("");
      await createPlan({ ...session, answered: nextAnswered }, userMessage, fromComposer ? text : "", session.answered);
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
    const { requestId, signal } = beginRequest(session.id);

    const result = await askInterview(story.story, nextAnswered, session.context, { signal });
    finishRequest(requestId);
    if (!result.ok) {
      store.update(session.id, (current) =>
        rollbackTurn(current, {
          messageId: userMessage.id,
          answered: session.answered,
          pendingQuestion: session.pendingQuestion,
        }),
      );
      const restored = restoreDraft(session.id, fromComposer ? text : "");
      if (result.stopped) showStopped(session.id, stoppedNotice(restored));
      else if (isActiveRequestSession(session.id)) setError(result.error);
      return;
    }
    applyInterviewTurn(session.id, result);
  }

  async function sendRefine(session: StorySession, text: string, fromComposer = true, intent?: "edit") {
    if (!session.plan) return;
    const baseSignature = planSignature(session.plan);
    const userMessage: ChatMessage = { id: newId(), role: "user", text };
    const history = session.messages
      .slice(-MAX_CHAT_HISTORY)
      .map((message) => ({ role: message.role, text: message.text }));
    store.update(session.id, (current) => ({ ...current, messages: [...current.messages, userMessage] }));
    if (fromComposer) setInput("");
    const { requestId, signal } = beginRequest(session.id);

    const result = await askDirector(
      {
        plan: session.plan,
        messages: history,
        message: text,
        answers: session.answered,
        collected: directorCollected(session.context, session.collected),
        references: session.references?.length ? session.references : undefined,
        context: session.context,
        decisions: buildDecisionHistory(session.messages),
        source: directorSource(session.title, session.source),
        intent,
      },
      { signal },
    );
    finishRequest(requestId);
    if (!result.ok) {
      store.update(session.id, (current) => rollbackTurn(current, { messageId: userMessage.id }));
      const restored = restoreDraft(session.id, fromComposer ? text : "");
      if (result.stopped) showStopped(session.id, stoppedNotice(restored));
      else if (isActiveRequestSession(session.id)) setError(result.error);
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
    setVoiceAdded((count) => voiceAddedAfter(count, "send"));
    if (active.phase === "discovery") void sendDiscovery(active, text);
    else void sendRefine(active, text);
  }

  function sendDiscoveryAction(label: string) {
    if (!active || busy || transcribing || uploading || active.phase !== "discovery") return;
    void sendDiscovery(active, label, false);
  }

  function sendAnswerOption(option: string) {
    if (!active || busy || transcribing || uploading || active.phase !== "discovery" || !active.pendingQuestion) return;
    void sendDiscovery(active, option, false);
  }

  function sendQuickAction(message: string) {
    if (!active || busy || transcribing || uploading || active.phase !== "refining") return;
    void sendRefine(active, message, false);
  }

  async function runOriginalityCheck(references: boolean) {
    if (!active?.plan || busy || transcribing || uploading) return;
    const session = active;
    const plan = active.plan;
    setOriginalityError((current) => (current?.id === session.id ? null : current));
    setWikipediaLookup(references);
    const { requestId, signal } = beginRequest(session.id);
    setOriginalityRun({ id: session.id, references });
    setBusyNote({ id: session.id, text: "Checking your story’s originality…" });
    const result = await checkOriginality(
      {
        title: session.title,
        plan,
        context: session.context,
        source: directorSource(session.title, session.source),
        dismissed: session.originality?.dismissed,
        references,
      },
      Date.now(),
      { signal },
    );
    clearBusyNote(session.id);
    setOriginalityRun((current) => (current?.id === session.id ? null : current));
    finishRequest(requestId);
    if (!result.ok) {
      if (result.stopped) showStopped(session.id, STOPPED_MESSAGE, "originality");
      else setOriginalityError({ id: session.id, text: result.error });
      return;
    }
    store.update(session.id, (current) => withOriginalityReport(current, result.report));
    recordUsage(session.id, result.usage);
  }

  function openReportPanel(id: ReportId) {
    if (!active || !showReportAction(id, active)) return;
    const running = id === "originality" ? originalityRun?.id === active.id : engagementRunId === active.id;
    if (reportEntry(id, active, running) === "confirm") {
      setConfirmReport(id);
      return;
    }
    setStopNotice(null);
    setOpenReport(id);
  }

  function acceptReport(id: ReportId, references: boolean) {
    setConfirmReport(null);
    if (!active || !showReportAction(id, active)) return;
    setStopNotice(null);
    setOpenReport(id);
    runConfirmedReport(id, references, {
      originality: (value) => void runOriginalityCheck(value),
      engagement: () => void runEngagementAnalysis(),
    });
  }

  function sendFindingAction(action: FindingAction, finding: OriginalityFinding) {
    if (!active || busy || transcribing || uploading || active.phase !== "refining") return;
    setOpenReport(null);
    void sendRefine(active, findingActionMessage(action, finding), false, action === "revise" ? "edit" : undefined);
  }

  async function runEngagementAnalysis() {
    if (!active?.plan || busy || transcribing || uploading) return;
    const session = active;
    const plan = active.plan;
    setEngagementError((current) => (current?.id === session.id ? null : current));
    const { requestId, signal } = beginRequest(session.id);
    setEngagementRunId(session.id);
    setBusyNote({ id: session.id, text: "Analysing your story scene by scene…" });
    const result = await checkEngagement(
      {
        title: session.title,
        plan,
        context: session.context,
        source: directorSource(session.title, session.source),
      },
      Date.now(),
      { signal },
    );
    clearBusyNote(session.id);
    setEngagementRunId((current) => (current === session.id ? null : current));
    finishRequest(requestId);
    if (!result.ok) {
      if (result.stopped) showStopped(session.id, STOPPED_MESSAGE, "engagement");
      else setEngagementError({ id: session.id, text: result.error });
      return;
    }
    store.update(session.id, (current) => withEngagementReport(current, result.report));
    recordUsage(session.id, result.usage);
  }

  function sendRecommendationAction(action: RecommendationAction, recommendation: EngagementRecommendation) {
    if (!active || busy || transcribing || uploading || active.phase !== "refining") return;
    const request = recommendationRequest(action, recommendation, active.engagement?.report.scenes);
    setOpenReport(null);
    void sendRefine(active, request.message, false, request.intent);
  }

  function dismissFinding(finding: OriginalityFinding) {
    if (!active || busy) return;
    store.update(active.id, (current) => withDismissedFinding(current, finding));
  }

  function restoreFinding(finding: OriginalityFinding) {
    if (!active || busy) return;
    store.update(active.id, (current) => withRestoredFinding(current, finding));
  }

  async function createPlan(
    session: StorySession,
    trigger?: ChatMessage,
    draft = "",
    previousAnswered?: StorySession["answered"],
  ) {
    const fail = ({ error: message, stopped }: { error: string; stopped?: true }) => {
      if (trigger || previousAnswered) {
        store.update(session.id, (current) =>
          rollbackTurn(current, { messageId: trigger?.id, answered: previousAnswered }),
        );
      }
      const restored = restoreDraft(session.id, draft);
      if (stopped) showStopped(session.id, stoppedNotice(restored));
      else if (isActiveRequestSession(session.id)) setError(message);
    };
    const story = storyForStep(session.title, session.source, "plan");
    if (!story.ok) {
      fail(story);
      return;
    }
    const { requestId, signal } = beginRequest(session.id);
    const result = await generatePlan(story.story, session.answered, session.collected, session.context, { signal });
    finishRequest(requestId);
    if (!result.ok) {
      fail(result);
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
    if (!withEditedAnswer(active, messageId, value)) return false;
    store.update(active.id, (current) => withEditedAnswer(current, messageId, value) ?? current);
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
    store.update(active.id, (current) => withSessionContext(current, change));
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
    const previous = sessionById(id)?.source;
    const replaced = previous?.name;
    let source = imported;
    let digestFailed = false;
    const { requestId, signal } = beginRequest(id);
    store.update(id, (current) => ({ ...current, source }));
    if (needsDigest(source)) {
      setBusyNote({ id, text: "Making a condensed version of your long story…" });
      const digest = await createDigest(source.name, source.text, { signal });
      if (digest.ok) {
        source = { ...source, digest: digest.digest };
        recordUsage(id, digest.usage);
      } else if (digest.stopped) {
        store.update(id, (current) => ({ ...current, source: previous }));
        clearBusyNote(id);
        finishRequest(requestId);
        showStopped(id, STOPPED_IMPORT_MESSAGE);
        return;
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
    const result = await askInterview(story.story, session.answered, session.context, { signal });
    clearBusyNote(id);
    finishRequest(requestId);
    if (!result.ok) {
      if (result.stopped) showStopped(id, STOPPED_MESSAGE);
      else if (isActiveRequestSession(id)) setError(result.error);
      return;
    }
    applyInterviewTurn(id, result);
  }

  async function placeImportedText(
    id: string,
    text: string,
    origin: "document" | "transcript",
    meta: { name: string; kind: SourceKind; characters: number; pages?: number },
    fromMic = false,
  ) {
    const session = sessionById(id);
    if (!session) return;
    const phase = session.phase === "refining" && session.plan ? "refining" : "discovery";
    const composerLimit = phase === "discovery" ? MAX_ANSWER_CHARACTERS : MAX_CHAT_MESSAGE_CHARACTERS;
    const route = routeLongText({ chars: meta.characters, origin, phase, composerLimit });
    if (route === "too-long-for-chat") {
      if (isActiveRequestSession(id)) (fromMic ? setMicError : setVoiceError)(tooLongForChatMessage(meta.characters));
      return;
    }
    if (route === "composer") {
      if (!isActiveRequestSession(id)) return;
      setInput((current) => appendToDraft(current, text, origin === "document" ? "\n\n" : " "));
      if (origin === "transcript") setComposerFocus((count) => count + 1);
      if (fromMic) setVoiceAdded((count) => voiceAddedAfter(count, "transcribed"));
      return;
    }
    await adoptSource(id, { ...meta, text });
  }

  async function transcribeInto(file: File, name: string, mode: "mic" | "upload") {
    if (!active) return;
    const id = active.id;
    if (mode === "mic") {
      micTranscriptionsRef.current += 1;
      setTranscribing(true);
      setMicError("");
      setVoiceAdded((count) => voiceAddedAfter(count, "record"));
    } else setUploading("audio");
    setVoiceError("");
    const controller = beginUpload();
    const result = await transcribeVoice(file, { signal: controller.signal, hint: transcribeHintFor(active) });
    finishUpload(controller);
    if (mode === "mic") {
      micTranscriptionsRef.current -= 1;
      if (!micTranscriptionsRef.current) setTranscribing(false);
    } else setUploading(null);
    const fail = mode === "mic" ? setMicError : setVoiceError;
    if (!result.ok) {
      if (result.stopped) showStopped(id, STOPPED_MESSAGE);
      else if (isActiveRequestSession(id)) fail(result.error);
      return;
    }
    recordUsage(id, result.usage);
    const checked = checkSourceText(result.text, `“${name}”`);
    if (!checked.ok) {
      if (isActiveRequestSession(id)) fail(checked.error);
      return;
    }
    await placeImportedText(
      id,
      checked.text,
      "transcript",
      { name, kind: "audio", characters: checked.text.length },
      mode === "mic",
    );
  }

  function handleVoice(file: File) {
    void transcribeInto(file, "Voice note", "mic");
  }

  function handleVoiceActive(recording: boolean) {
    if (!recording) return;
    setMicError("");
    setVoiceAdded((count) => voiceAddedAfter(count, "record"));
  }

  function editDraft(value: string) {
    setInput(value);
    setVoiceAdded((count) => voiceAddedAfter(count, "edit"));
  }

  async function handleImage(file: File) {
    if (!active) return;
    const id = active.id;
    setUploading("image");
    setVoiceError("");
    const controller = beginUpload();
    const result = await analyzeImage(file, { signal: controller.signal });
    finishUpload(controller);
    setUploading(null);
    if (!result.ok) {
      if (result.stopped) showStopped(id, STOPPED_MESSAGE);
      else setVoiceError(result.error);
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
    const controller = beginUpload();
    const result = await importDocument(file, { signal: controller.signal });
    finishUpload(controller);
    setUploading(null);
    if (!result.ok) {
      if (result.stopped) showStopped(id, STOPPED_MESSAGE);
      else if (isActiveRequestSession(id)) setVoiceError(result.error);
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
    setExploring(false);
    setTitleDraft("");
    setView("chat");
    setError("");
    closeDrawer();
  }

  function selectSession(id: string) {
    store.select(id);
    setCreating(false);
    setExploring(false);
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
        onNav={() => {
          setSettingsSection("usage");
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
        ) : showTitlePrompt && exploring ? (
          <StoryIdeas onDevelop={developConcept} onBack={closeIdeas} />
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
            <div className="new-chat-ideas">
              <h3 className="new-chat-ideas-title">Don’t have a story idea yet?</h3>
              <p className="muted new-chat-ideas-text">
                Let AI help you discover your next story through creative ideas, premises and plot possibilities.
              </p>
              <button
                ref={exploreButtonRef}
                className="button secondary new-chat-ideas-button"
                type="button"
                onClick={() => setExploring(true)}
              >
                <span aria-hidden="true">✨</span> Explore story suggestions
              </button>
            </div>
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
              micError={micError}
              voiceAdded={voiceAdded}
              canGeneratePlan={
                active.phase === "discovery" &&
                (active.answered.length >= 1 || contextReadiness(active.context ?? EMPTY_CONTEXT).ready)
              }
              uploading={uploading}
              busyText={busyNote?.id === active.id ? busyNote.text : undefined}
              stopNotice={stopNotice?.id === active.id ? stopNotice.text : ""}
              openReport={openReport !== null && showReportAction(openReport, active) ? openReport : null}
              onOpenReport={openReportPanel}
              onInput={editDraft}
              onSend={send}
              onStop={stopRequest}
              onStopUpload={stopUploads}
              onQuickAction={sendQuickAction}
              onDiscoveryAction={sendDiscoveryAction}
              onAnswerOption={sendAnswerOption}
              onGeneratePlan={doGeneratePlan}
              onAccept={acceptProposal}
              onReject={rejectProposal}
              onEditAnswer={editAnswer}
              onVoice={handleVoice}
              onVoiceActive={handleVoiceActive}
              onClearMicError={() => setMicError("")}
              onUpload={handleUpload}
              onRetry={() => void openConversation(active.id, active.title, active.source, active.context)}
            />
            {openReport === "originality" && showOriginalityAction(active) && (
              <OriginalityPanel
                plan={active.plan}
                context={active.context}
                originality={active.originality}
                defaultReferences={wikipediaLookup}
                busy={busy || transcribing || uploading !== null}
                running={originalityRun?.id === active.id ? { references: originalityRun.references } : null}
                error={originalityError?.id === active.id ? originalityError.text : ""}
                stopped={stopNotice?.id === active.id && stopNotice.report === "originality"}
                onRun={(references) => void runOriginalityCheck(references)}
                onStop={stopRequest}
                onClose={() => setOpenReport(null)}
                onAction={sendFindingAction}
                onDismiss={dismissFinding}
                onRestore={restoreFinding}
              />
            )}
            {openReport === "engagement" && showEngagementAction(active) && (
              <EngagementPanel
                plan={active.plan}
                context={active.context}
                engagement={active.engagement}
                busy={busy || transcribing || uploading !== null}
                running={engagementRunId === active.id}
                error={engagementError?.id === active.id ? engagementError.text : ""}
                stopped={stopNotice?.id === active.id && stopNotice.report === "engagement"}
                onRun={() => void runEngagementAnalysis()}
                onStop={stopRequest}
                onClose={() => setOpenReport(null)}
                onAction={sendRecommendationAction}
              />
            )}
            <StoryEditor
              session={active}
              busy={busy}
              onEditPlan={editPlan}
              onApproveFact={(key) => updateContext((context) => approveFact(context, key))}
              onRemoveFact={(key) => updateContext((context) => removeFact(context, key))}
              onEditFact={(key, value) => updateContext((context) => editFact(context, key, value))}
              onAddLook={(entity, value) => updateContext((context) => addVisualLook(context, entity, value))}
            />
            {confirmReport && showReportAction(confirmReport, active) && (
              <ReportConfirmDialog
                key={`${active.id}:${confirmReport}`}
                copy={REPORT_CONFIRM_COPY[confirmReport]}
                busy={busy || transcribing || uploading !== null}
                option={wikipediaLookup}
                onAccept={(references) => acceptReport(confirmReport, references)}
                onClose={() => setConfirmReport(null)}
              />
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
