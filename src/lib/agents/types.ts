import type { CollectedItem } from "@/lib/interview";
import type { StoryContext } from "@/lib/story-context";
import type { ShotPlan } from "@/lib/story-planning";
import type { UsageRecord } from "@/lib/usage";

export const SPECIALIST_IDS = [
  "story-analyst",
  "cinematography-director",
  "sound-director",
  "editing-director",
  "continuity-reviewer",
] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export const SPECIALIST_LABELS: Record<SpecialistId, string> = {
  "story-analyst": "Story",
  "cinematography-director": "Camera",
  "sound-director": "Sound",
  "editing-director": "Editing",
  "continuity-reviewer": "Consistency",
};

/** Analysis of a filmmaker-uploaded reference image. Text only — the image itself is never stored. */
export type ImageReference = {
  id: string;
  name: string;
  summary: string;
  composition: string;
  lighting: string;
  cameraAngle: string;
  colour: string;
  environment: string;
  mood: string;
  /** How this reference could shape the film's shots. */
  shotIdeas: string;
};

export type RecommendationPriority = "high" | "medium" | "low";

export type Recommendation = {
  specialist: SpecialistId;
  /** What it applies to, e.g. "S01_SH02", "Scene 1", "Character: Elias" or "Overall". */
  target: string;
  issue: string;
  recommendation: string;
  rationale: string;
  priority: RecommendationPriority;
};

/** POST /api/story/director request body. */
export type DirectorRequest = {
  plan: ShotPlan;
  /** Recent conversation, oldest first. */
  messages: { role: "user" | "agent"; text: string }[];
  /** The filmmaker's new message. */
  message: string;
  /** Interview answers and collected creative details: approved project context. */
  answers?: { question: string; answer: string }[];
  collected?: CollectedItem[];
  /** Analysed reference images (text only). The cinematography specialist uses these. */
  references?: ImageReference[];
  /** Structured 20-category StoryContext (facts with source/approval, open questions). */
  context?: StoryContext;
  /** Earlier proposals the filmmaker applied or discarded, newest last. Rejected ideas must not be re-proposed unless asked. */
  decisions?: DecisionRecord[];
};

/** One resolved proposal: what was asked, what changed, and whether the filmmaker applied or discarded it. */
export type DecisionRecord = {
  status: "accepted" | "rejected";
  request: string;
  changes: string[];
};

/** POST /api/story/image success response. Body: raw image bytes, header `X-Image-Type` (image/png | image/jpeg | image/webp) and optional `X-Image-Name`. */
export type ImageAnalysisResponse = {
  reference: ImageReference;
  usage: UsageRecord;
};

/** POST /api/story/director success response. */
export type DirectorResponse = {
  /** "specialists" when the orchestrator consulted specialists; "refine" when it fell back to a general plan edit. */
  mode: "specialists" | "refine";
  /** One coherent Creative Director reply. */
  reply: string;
  /** Specialists that were invoked and succeeded. */
  specialists: SpecialistId[];
  /** Specialists that were invoked but failed (timeout, invalid output, API error). */
  failed: SpecialistId[];
  recommendations: Recommendation[];
  /** Disagreements between specialists, explained. */
  conflicts: string[];
  /** One bullet per concrete change in `plan`. */
  changeSummary: string[];
  /** Proposed plan needing Apply/Discard, or null when the response is advice only. */
  plan: ShotPlan | null;
  /** One record per model call made. */
  usage: UsageRecord[];
};
