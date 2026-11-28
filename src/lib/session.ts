import type { ImageReference, Recommendation, SpecialistId } from "@/lib/agents/types";
import type { CollectedItem } from "@/lib/interview";
import { type SessionEngagement, sessionEngagementSchema } from "@/lib/engagement";
import { type SessionOriginality, sessionOriginalitySchema } from "@/lib/originality";
import { storyContextSchema } from "@/lib/story-context-schema";
import type { StorySource } from "@/lib/source-text";
import type { StoryContext } from "@/lib/story-context";
import { planOutput, type ShotPlan } from "@/lib/story-planning";
import { isUsageRecord, type UsageRecord } from "@/lib/usage";

export const SESSIONS_STORAGE_KEY = "story-studio.sessions.v1";
export const SESSIONS_STORAGE_VERSION = 1 as const;
export const MAX_SESSION_TITLE = 120;

/** A session is one project: a conversation plus the story document it produces. */
export type SessionPhase = "discovery" | "refining";

export type DiscoveryExchange = { question: string; answer: string };

export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  /** Rationale, recommendation or creative suggestion, shown muted under the message. */
  suggestion?: string;
  /** Present on a refine proposal: the concrete edits the agent made. */
  changeSummary?: string[];
  /** Present only while status === "pending"; dropped once resolved to save space. */
  proposedPlan?: ShotPlan;
  status?: "pending" | "accepted" | "rejected";
  /** Signature of the plan the proposal was built from; Apply confirms if the plan changed since. */
  baseSignature?: string;
  /** On a discovery question: short answer choices shown as tappable buttons. */
  options?: string[];
  /** On a user message: index into `answered` that this message answered (enables editing). */
  answerIndex?: number;
  /** On a Creative Director reply: specialists consulted, their recommendations and any conflicts. */
  specialists?: SpecialistId[];
  failedSpecialists?: SpecialistId[];
  recommendations?: Recommendation[];
  conflicts?: string[];
  /** On an agent message: the analysis of a reference image the filmmaker uploaded. */
  reference?: ImageReference;
};

export function planSignature(plan: ShotPlan | null): string {
  const text = JSON.stringify(plan);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 33) ^ text.charCodeAt(index);
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

export type StorySession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  phase: SessionPhase;
  /** True once the interview has gathered enough and offered to plan. */
  readyToPlan: boolean;
  pendingQuestion: string | null;
  answered: DiscoveryExchange[];
  collected: CollectedItem[];
  messages: ChatMessage[];
  plan: ShotPlan | null;
  usage: UsageRecord[];
  /** Analysed reference images (text only). Optional so sessions saved earlier still load. */
  references?: ImageReference[];
  /** 20-category StoryContext: user facts, AI suggestions, approvals, open questions. */
  context?: StoryContext;
  /** Imported story (TXT, PDF or a long voice note): full text plus a digest when it is long. */
  source?: StorySource;
  /** Latest originality review and the findings the filmmaker dismissed. Optional so older sessions still load. */
  originality?: SessionOriginality;
  /** Latest Audience Retention Predictor report. Optional so older sessions still load. */
  engagement?: SessionEngagement;
};

export type PersistedSessions = {
  version: typeof SESSIONS_STORAGE_VERSION;
  activeId: string | null;
  sessions: StorySession[];
};

export function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`;
}

export function createSession(title: string): StorySession {
  const now = Date.now();
  const clean = title.trim().slice(0, MAX_SESSION_TITLE) || "Untitled project";
  return {
    id: newId(),
    title: clean,
    createdAt: now,
    updatedAt: now,
    phase: "discovery",
    readyToPlan: false,
    pendingQuestion: null,
    answered: [],
    collected: [],
    messages: [],
    plan: null,
    usage: [],
  };
}

export function totalUsage(records: UsageRecord[]) {
  return records.reduce(
    (sum, record) => ({
      inputTokens: sum.inputTokens + record.inputTokens,
      outputTokens: sum.outputTokens + record.outputTokens,
      totalTokens: sum.totalTokens + record.totalTokens,
      cachedTokens: sum.cachedTokens + (record.cachedTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 },
  );
}

/** Drop the heavy proposedPlan snapshots off any non-pending message before persisting. */
function pruneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.status && message.status !== "pending" && message.proposedPlan
      ? { ...message, proposedPlan: undefined }
      : message,
  );
}

export function serializeSessions(sessions: StorySession[], activeId: string | null): PersistedSessions {
  return {
    version: SESSIONS_STORAGE_VERSION,
    activeId,
    sessions: sessions.map((session) => ({ ...session, messages: pruneMessages(session.messages) })),
  };
}

export function isStorySource(value: unknown): value is StorySource {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    (record.kind === "txt" || record.kind === "pdf" || record.kind === "audio" || record.kind === "suggestion") &&
    typeof record.text === "string" &&
    typeof record.characters === "number" &&
    Number.isFinite(record.characters) &&
    (record.digest === undefined || typeof record.digest === "string") &&
    (record.pages === undefined || typeof record.pages === "number")
  );
}

/** Keep the session even if its saved story source is malformed; drop only the bad source. */
/** Keep the session even if its saved engagement report is malformed; drop only the report. */
function withValidEngagement(session: StorySession): StorySession {
  if (session.engagement === undefined || sessionEngagementSchema.safeParse(session.engagement).success) return session;
  const { engagement: _dropped, ...rest } = session;
  return rest;
}

/** Keep the session even if its saved originality report is malformed; drop only the report. */
function withValidOriginality(session: StorySession): StorySession {
  if (session.originality === undefined || sessionOriginalitySchema.safeParse(session.originality).success) return session;
  const { originality: _dropped, ...rest } = session;
  return rest;
}

function withValidSource(session: StorySession): StorySession {
  if (session.source === undefined || isStorySource(session.source)) return session;
  const { source: _dropped, ...rest } = session;
  return rest;
}

function isStorySession(value: unknown): value is StorySession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    (record.phase === "discovery" || record.phase === "refining") &&
    typeof record.readyToPlan === "boolean" &&
    (record.pendingQuestion === null || typeof record.pendingQuestion === "string") &&
    Array.isArray(record.messages) &&
    record.messages.every(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        typeof (message as Record<string, unknown>).id === "string" &&
        (message as Record<string, unknown>).role !== undefined &&
        ["user", "agent"].includes((message as Record<string, unknown>).role as string) &&
        typeof (message as Record<string, unknown>).text === "string",
    ) &&
    Array.isArray(record.answered) &&
    record.answered.every(
      (answer) =>
        Boolean(answer) &&
        typeof answer === "object" &&
        typeof (answer as Record<string, unknown>).question === "string" &&
        typeof (answer as Record<string, unknown>).answer === "string",
    ) &&
    Array.isArray(record.collected) &&
    record.collected.every(
      (item) =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).label === "string" &&
        typeof (item as Record<string, unknown>).detail === "string",
    ) &&
    (record.plan === null || planOutput.safeParse(record.plan).success) &&
    Array.isArray(record.usage) &&
    record.usage.every(isUsageRecord) &&
    (record.context === undefined || storyContextSchema.safeParse(record.context).success)
  );
}

export function parseSessions(raw: string | null): PersistedSessions {
  const empty: PersistedSessions = { version: SESSIONS_STORAGE_VERSION, activeId: null, sessions: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    const record = parsed as Record<string, unknown>;
    if (record.version !== SESSIONS_STORAGE_VERSION || !Array.isArray(record.sessions)) return empty;
    const sessions = record.sessions.filter(isStorySession).map(withValidSource).map(withValidOriginality).map(withValidEngagement);
    const activeId = typeof record.activeId === "string" && sessions.some((s) => s.id === record.activeId)
      ? record.activeId
      : (sessions[0]?.id ?? null);
    return { version: SESSIONS_STORAGE_VERSION, activeId, sessions };
  } catch {
    return empty;
  }
}
