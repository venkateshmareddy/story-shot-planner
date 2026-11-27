import type { ResolvedInterviewTurn } from "@/lib/interview";
import {
  MAX_CHAT_HISTORY,
  MAX_CHAT_MESSAGE_CHARACTERS,
  MAX_VOICE_BYTES,
} from "@/lib/story-input";
import type { RefineMessage, ShotPlan } from "@/lib/story-planning";
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

export async function generatePlan(
  story: string,
  answers: { question: string; answer: string }[],
): Promise<AgentResult<{ plan: ShotPlan } & WithUsage>> {
  const result = await postJson("/api/story/plan", { step: "plan", story, answers });
  if (!result.ok) return result;
  const { data } = result;
  if (!data.title || !Array.isArray(data.scenes)) {
    return { ok: false, error: "The plan couldn’t be generated. Try again." };
  }
  return { ok: true, plan: data as unknown as ShotPlan, usage: pickUsage(data) };
}

export async function refinePlan(
  plan: ShotPlan,
  history: RefineMessage[],
  message: string,
): Promise<AgentResult<{ reply: string; changeSummary: string[]; plan: ShotPlan } & WithUsage>> {
  const trimmedHistory = history
    .map((item): RefineMessage => ({ role: item.role, text: item.text.slice(0, MAX_CHAT_MESSAGE_CHARACTERS) }))
    .filter((item) => item.text.trim().length > 0)
    .slice(-MAX_CHAT_HISTORY);
  const result = await postJson("/api/story/refine", {
    plan,
    messages: trimmedHistory,
    message: message.slice(0, MAX_CHAT_MESSAGE_CHARACTERS),
  });
  if (!result.ok) return result;
  const { data } = result;
  return {
    ok: true,
    reply: typeof data.reply === "string" ? data.reply : "",
    changeSummary: Array.isArray(data.changeSummary) ? (data.changeSummary as string[]) : [],
    plan: data.plan as ShotPlan,
    usage: pickUsage(data),
  };
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
