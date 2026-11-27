import {
  type DirectorRequest,
  type DirectorResponse,
  type Recommendation,
  SPECIALIST_LABELS,
  type SpecialistId,
} from "@/lib/agents/types";
import type { CollectedItem, ResolvedInterviewTurn } from "@/lib/interview";
import {
  BYTES_PER_MB,
  MAX_ANSWER_CHARACTERS,
  MAX_CHAT_HISTORY,
  MAX_CHAT_MESSAGE_CHARACTERS,
  MAX_STORY_CHARACTERS,
  MAX_UPLOAD_MB,
  MAX_VOICE_BYTES,
} from "@/lib/story-input";
import type { ShotPlan } from "@/lib/story-planning";
import { isUsageRecord, type UsageRecord } from "@/lib/usage";

export type AgentResult<T> = ({ ok: true } & T) | { ok: false; error: string };

type WithUsage = { usage?: UsageRecord };

const GENERIC_ERROR = "This step couldn’t connect. Try again.";

async function postJson(path: string, body: unknown): Promise<AgentResult<{ data: Record<string, unknown> }>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, error: typeof result.error === "string" ? result.error : GENERIC_ERROR };
    }
    return { ok: true, data: result };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

function pickUsage(data: Record<string, unknown>): UsageRecord | undefined {
  return isUsageRecord(data.usage) ? data.usage : undefined;
}

export async function askInterview(
  story: string,
  answered: { question: string; answer: string }[],
): Promise<AgentResult<{ turn: ResolvedInterviewTurn } & WithUsage>> {
  const result = await postJson("/api/story/plan", { step: "interview", story, answered });
  if (!result.ok) return result;
  const { data } = result;
  if (data.status !== "ask" && data.status !== "complete") {
    return { ok: false, error: "The creative director returned an unexpected result. Try again." };
  }
  return { ok: true, turn: data as unknown as ResolvedInterviewTurn, usage: pickUsage(data) };
}

const MAX_COLLECTED_ITEMS = 40;

export async function generatePlan(
  story: string,
  answers: { question: string; answer: string }[],
  collected: CollectedItem[],
): Promise<AgentResult<{ plan: ShotPlan } & WithUsage>> {
  const result = await postJson("/api/story/plan", {
    step: "plan",
    story,
    answers,
    collected: collected.slice(0, MAX_COLLECTED_ITEMS),
  });
  if (!result.ok) return result;
  const { data } = result;
  if (!data.title || !Array.isArray(data.scenes)) {
    return { ok: false, error: "The plan couldn’t be generated. Try again." };
  }
  return { ok: true, plan: data as unknown as ShotPlan, usage: pickUsage(data) };
}

function isSpecialistId(value: unknown): value is SpecialistId {
  return typeof value === "string" && Object.hasOwn(SPECIALIST_LABELS, value);
}

function specialistList(value: unknown): SpecialistId[] {
  return Array.isArray(value) ? value.filter(isSpecialistId) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function isRecommendation(value: unknown): value is Recommendation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isSpecialistId(record.specialist) &&
    typeof record.target === "string" &&
    typeof record.recommendation === "string" &&
    typeof record.rationale === "string" &&
    (record.priority === "high" || record.priority === "medium" || record.priority === "low")
  );
}

function isShotPlan(value: unknown): value is ShotPlan {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.title === "string" && Array.isArray(record.scenes);
}

export async function askDirector(request: DirectorRequest): Promise<AgentResult<{ response: DirectorResponse }>> {
  const body: DirectorRequest = {
    plan: request.plan,
    messages: request.messages
      .map((item) => ({ role: item.role, text: item.text.slice(0, MAX_CHAT_MESSAGE_CHARACTERS) }))
      .filter((item) => item.text.trim().length > 0)
      .slice(-MAX_CHAT_HISTORY),
    message: request.message.slice(0, MAX_CHAT_MESSAGE_CHARACTERS),
    answers: request.answers?.map((item) => ({ question: item.question, answer: item.answer.slice(0, MAX_ANSWER_CHARACTERS) })),
    collected: request.collected?.slice(0, MAX_COLLECTED_ITEMS),
  };
  const result = await postJson("/api/story/director", body);
  if (!result.ok) return result;
  const { data } = result;
  if (typeof data.reply !== "string" || (data.plan != null && !isShotPlan(data.plan))) {
    return { ok: false, error: "The creative team returned an unexpected result. Try again." };
  }
  return {
    ok: true,
    response: {
      mode: data.mode === "refine" ? "refine" : "specialists",
      reply: data.reply,
      specialists: specialistList(data.specialists),
      failed: specialistList(data.failed),
      recommendations: Array.isArray(data.recommendations) ? data.recommendations.filter(isRecommendation) : [],
      conflicts: stringList(data.conflicts),
      changeSummary: stringList(data.changeSummary),
      plan: isShotPlan(data.plan) ? data.plan : null,
      usage: Array.isArray(data.usage) ? data.usage.filter(isUsageRecord) : [],
    },
  };
}

export async function importDocument(file: File): Promise<AgentResult<{ text: string }>> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "txt" && extension !== "pdf") {
    return { ok: false, error: "Choose a TXT or PDF file." };
  }
  const limit = MAX_UPLOAD_MB[extension];
  if (file.size > limit * BYTES_PER_MB) {
    return { ok: false, error: `Choose a file that is ${limit} MB or smaller.` };
  }
  try {
    let text: string;
    if (extension === "pdf") {
      const response = await fetch("/api/story/import", {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof result.text !== "string") {
        return { ok: false, error: typeof result.error === "string" ? result.error : "The file couldn’t be imported." };
      }
      text = result.text;
    } else {
      text = await file.text();
    }
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "That file looks empty." };
    return { ok: true, text: trimmed.slice(0, MAX_STORY_CHARACTERS) };
  } catch {
    return { ok: false, error: "The file couldn’t be imported. Try again or paste the text." };
  }
}

export async function transcribeVoice(file: File): Promise<AgentResult<{ text: string } & WithUsage>> {
  if (file.size > MAX_VOICE_BYTES) {
    return { ok: false, error: "Choose a voice note that’s 4 MB or smaller." };
  }
  try {
    const response = await fetch("/api/story/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Audio-Extension": file.name.split(".").pop()?.toLowerCase() ?? "",
      },
      body: file,
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof result.text !== "string") {
      return {
        ok: false,
        error: typeof result.error === "string" ? result.error : "The voice note couldn’t be transcribed.",
      };
    }
    return { ok: true, text: result.text, usage: pickUsage(result) };
  } catch {
    return { ok: false, error: "The voice note couldn’t be transcribed. Try again or type your message." };
  }
}
