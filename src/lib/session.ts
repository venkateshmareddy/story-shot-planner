import type { Recommendation, SpecialistId } from "@/lib/agents/types";
import type { CollectedItem } from "@/lib/interview";
import type { ShotPlan } from "@/lib/story-planning";
import type { UsageRecord } from "@/lib/usage";

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
  /** On a user message: index into `answered` that this message answered (enables editing). */
  answerIndex?: number;
  /** On a Creative Director reply: specialists consulted, their recommendations and any conflicts. */
  specialists?: SpecialistId[];
  failedSpecialists?: SpecialistId[];
  recommendations?: Recommendation[];
  conflicts?: string[];
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
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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

function isStorySession(value: unknown): value is StorySession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    Array.isArray(record.messages) &&
    Array.isArray(record.answered) &&
    Array.isArray(record.usage)
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
    const sessions = record.sessions.filter(isStorySession);
    const activeId = typeof record.activeId === "string" && sessions.some((s) => s.id === record.activeId)
      ? record.activeId
      : (sessions[0]?.id ?? null);
    return { version: SESSIONS_STORAGE_VERSION, activeId, sessions };
  } catch {
    return empty;
  }
}
