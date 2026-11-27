import {
  type DirectorRequest,
  type DirectorResponse,
  type ImageAnalysisResponse,
  type ImageReference,
  type Recommendation,
  SPECIALIST_LABELS,
  type SpecialistId,
} from "@/lib/agents/types";
import type { CollectedItem, ResolvedInterviewTurn } from "@/lib/interview";
import {
  checkSourceText,
  decodeTextFile,
  type DigestResponse,
  MAX_DIGEST_CHARACTERS,
} from "@/lib/source-text";
import {
  BYTES_PER_MB,
  MAX_ANSWER_CHARACTERS,
  MAX_CHAT_HISTORY,
  MAX_CHAT_MESSAGE_CHARACTERS,
  MAX_UPLOAD_MB,
  MAX_VOICE_BYTES,
} from "@/lib/story-input";
import {
  EMPTY_CONTEXT,
  MAX_CONTEXT_FACTS,
  MAX_UNRESOLVED,
  type ContextFact,
  type StoryContext,
  toCollected,
} from "@/lib/story-context";
import { contextFactSchema } from "@/lib/story-context-schema";
import { MAX_DECISIONS, type ShotPlan } from "@/lib/story-planning";
import { documentExtensionOf, imageTypeOf, UNSUPPORTED_UPLOAD } from "@/lib/upload";
import { isUsageRecord, type UsageRecord } from "@/lib/usage";

export { imageTypeOf };

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

/** Keeps every well-formed fact and drops the rest; null when the value isn't a context at all. */
export function parseStoryContext(value: unknown): StoryContext | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.facts) || !Array.isArray(record.unresolved)) return null;
  const facts = record.facts
    .map((fact) => contextFactSchema.safeParse(fact))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data as ContextFact)
    .slice(0, MAX_CONTEXT_FACTS);
  const unresolved = record.unresolved
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim().slice(0, 300))
    .slice(0, MAX_UNRESOLVED);
  return { facts, unresolved };
}

export async function askInterview(
  story: string,
  answered: { question: string; answer: string }[],
  context?: StoryContext,
): Promise<AgentResult<{ turn: ResolvedInterviewTurn; context?: StoryContext } & WithUsage>> {
  const result = await postJson("/api/story/plan", { step: "interview", story, answered, context });
  if (!result.ok) return result;
  const { data } = result;
  if (data.status !== "ask" && data.status !== "complete") {
    return { ok: false, error: "The creative director returned an unexpected result. Try again." };
  }
  return {
    ok: true,
    turn: data as unknown as ResolvedInterviewTurn,
    context: parseStoryContext(data.context) ?? undefined,
    usage: pickUsage(data),
  };
}

const MAX_COLLECTED_ITEMS = 40;
const MAX_PLAN_COLLECTED = 80;

export function directorCollected(context: StoryContext | undefined, collected: CollectedItem[]): CollectedItem[] {
  return context ? toCollected(context, MAX_COLLECTED_ITEMS) : collected.slice(0, MAX_COLLECTED_ITEMS);
}

export async function generatePlan(
  story: string,
  answers: { question: string; answer: string }[],
  collected: CollectedItem[],
  context?: StoryContext,
): Promise<AgentResult<{ plan: ShotPlan } & WithUsage>> {
  const result = await postJson("/api/story/plan", {
    step: "plan",
    story,
    answers,
    collected: context ? toCollected(context, MAX_PLAN_COLLECTED) : collected.slice(0, MAX_PLAN_COLLECTED),
    context: context ?? EMPTY_CONTEXT,
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
    references: request.references?.length ? request.references.slice(-MAX_REFERENCES) : undefined,
    context: request.context,
    decisions: request.decisions?.slice(-MAX_DECISIONS),
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

export type ImportedDocument = { text: string; characters: number; pages?: number };

export async function importDocument(file: File): Promise<AgentResult<ImportedDocument>> {
  const extension = documentExtensionOf(file.name);
  if (!extension) return { ok: false, error: UNSUPPORTED_UPLOAD };
  const limit = MAX_UPLOAD_MB[extension];
  if (file.size > limit * BYTES_PER_MB) {
    return { ok: false, error: `Choose a file that is ${limit} MB or smaller.` };
  }
  if (file.size === 0) return { ok: false, error: "That file looks empty." };
  const label = `“${file.name}”`;
  try {
    if (extension === "txt") {
      const decoded = decodeTextFile(new Uint8Array(await file.arrayBuffer()));
      if (!decoded.ok) return decoded;
      const checked = checkSourceText(decoded.text, label);
      if (!checked.ok) return checked;
      return { ok: true, text: checked.text, characters: checked.text.length };
    }
    const response = await fetch("/api/story/import", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof result.text !== "string") {
      return { ok: false, error: typeof result.error === "string" ? result.error : "The file couldn’t be imported." };
    }
    const checked = checkSourceText(result.text, label);
    if (!checked.ok) return checked;
    const pages = typeof result.pages === "number" && Number.isInteger(result.pages) && result.pages > 0 ? result.pages : undefined;
    return { ok: true, text: checked.text, characters: checked.text.length, pages };
  } catch {
    return { ok: false, error: "The file couldn’t be imported. Try again or paste the text." };
  }
}

export async function createDigest(name: string, text: string): Promise<AgentResult<DigestResponse>> {
  const result = await postJson("/api/story/digest", { name, text });
  if (!result.ok) return result;
  const { data } = result;
  if (typeof data.digest !== "string" || !data.digest.trim() || data.digest.length > MAX_DIGEST_CHARACTERS) {
    return { ok: false, error: "The condensed version of the story came back incomplete. Import the file again." };
  }
  return {
    ok: true,
    digest: data.digest,
    chunks: typeof data.chunks === "number" ? data.chunks : 0,
    usage: Array.isArray(data.usage) ? data.usage.filter(isUsageRecord) : [],
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
        "X-Audio-Type": file.type.replace(/[^\x20-\x7e]/g, ""),
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

export const MAX_REFERENCES = 6;
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_REFERENCE_FIELD = 1_500;
const REFERENCE_FIELDS = [
  "id",
  "name",
  "summary",
  "composition",
  "lighting",
  "cameraAngle",
  "colour",
  "environment",
  "mood",
  "shotIdeas",
] as const satisfies readonly (keyof ImageReference)[];

function parseReference(value: unknown): ImageReference | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!REFERENCE_FIELDS.every((field) => typeof record[field] === "string")) return null;
  if (!(record.id as string).trim() || !(record.summary as string).trim()) return null;
  return Object.fromEntries(
    REFERENCE_FIELDS.map((field) => [field, (record[field] as string).slice(0, MAX_REFERENCE_FIELD)]),
  ) as ImageReference;
}

// Header values must be ByteStrings; keep the name to a safe ASCII subset.
function headerSafeName(name: string): string {
  return name.replace(/[^\w .()-]/g, "_").slice(0, 120);
}

export async function analyzeImage(file: File): Promise<AgentResult<ImageAnalysisResponse>> {
  const type = imageTypeOf(file);
  if (!type) return { ok: false, error: "Choose a PNG, JPG or WebP image." };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "Choose an image that’s 4 MB or smaller." };
  if (file.size === 0) return { ok: false, error: "That image looks empty." };
  try {
    const response = await fetch("/api/story/image", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Image-Type": type, "X-Image-Name": headerSafeName(file.name) },
      body: file,
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, error: typeof result.error === "string" ? result.error : "The image couldn’t be read. Try again." };
    }
    const reference = parseReference(result.reference);
    if (!reference || !isUsageRecord(result.usage)) {
      return { ok: false, error: "The image study returned an unexpected result. Try again." };
    }
    return { ok: true, reference, usage: result.usage };
  } catch {
    return { ok: false, error: "The image couldn’t be read. Try again." };
  }
}
