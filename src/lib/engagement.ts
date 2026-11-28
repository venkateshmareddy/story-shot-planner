// Audience Retention Predictor — shared contract (client-safe). An AI-estimated engagement POTENTIAL from the story
// itself; never measured audience retention, drop-off or box office. Scores the AI gives are per dimension and per
// scene sub-rating; the overall score, bands and the curve are computed here, in code, with a documented formula.
import { z } from "zod";
import { storyContextSchema } from "./story-context-schema";
import { planOutput } from "./story-planning";

export const ENGAGEMENT_DIMENSIONS = [
  "opening_hook",
  "character_engagement",
  "pacing",
  "suspense_curiosity",
  "emotional_engagement",
  "scene_effectiveness",
  "climax_resolution",
] as const;
export type EngagementDimension = (typeof ENGAGEMENT_DIMENSIONS)[number];

export const ENGAGEMENT_DIMENSION_LABELS: Record<EngagementDimension, string> = {
  opening_hook: "Opening hook",
  character_engagement: "Character engagement",
  pacing: "Pacing",
  suspense_curiosity: "Suspense and curiosity",
  emotional_engagement: "Emotional engagement",
  scene_effectiveness: "Scene effectiveness",
  climax_resolution: "Climax and resolution",
};

/** Weights for the overall score; they sum to 1 and are renormalised over dimensions that have evidence. */
export const DIMENSION_WEIGHTS: Record<EngagementDimension, number> = {
  opening_hook: 0.15,
  character_engagement: 0.15,
  pacing: 0.15,
  suspense_curiosity: 0.15,
  emotional_engagement: 0.15,
  scene_effectiveness: 0.1,
  climax_resolution: 0.15,
};

/** Fewer scored dimensions than this → no overall score ("not enough evidence"). */
export const MIN_SCORED_DIMENSIONS = 4;

export const SCORE_BANDS = [
  { min: 85, label: "Strong" },
  { min: 70, label: "Solid" },
  { min: 50, label: "Mixed" },
  { min: 30, label: "Weak" },
  { min: 0, label: "Very weak" },
] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number]["label"];

export function bandFor(score: number): ScoreBand {
  return (SCORE_BANDS.find((band) => score >= band.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1]).label;
}

/** Weighted mean of the dimensions that have a score, renormalised; null when fewer than MIN_SCORED_DIMENSIONS. */
export function overallScore(scores: Partial<Record<EngagementDimension, number | null>>): number | null {
  const scored = ENGAGEMENT_DIMENSIONS.filter((dimension) => typeof scores[dimension] === "number");
  if (scored.length < MIN_SCORED_DIMENSIONS) return null;
  const weight = scored.reduce((sum, dimension) => sum + DIMENSION_WEIGHTS[dimension], 0);
  const total = scored.reduce((sum, dimension) => sum + DIMENSION_WEIGHTS[dimension] * (scores[dimension] as number), 0);
  return Math.round(total / weight);
}

/** Per-scene sub-ratings the AI gives (1–5, change 0–2), each backed by evidence in the scene assessment. */
export const sceneRatingsSchema = z.object({
  tension: z.number().int().min(1).max(5),
  curiosity: z.number().int().min(1).max(5),
  emotion: z.number().int().min(1).max(5),
  /** 0 = nothing changes, 1 = something shifts, 2 = the story turns. */
  change: z.number().int().min(0).max(2),
});
export type SceneRatings = z.infer<typeof sceneRatingsSchema>;

/** The curve formula: a scene's engagement potential (0–100) from its sub-ratings. Quiet but moving scenes score on emotion. */
export function scenePotential(ratings: SceneRatings): number {
  const value = 100 * (0.3 * (ratings.tension / 5) + 0.25 * (ratings.curiosity / 5) + 0.25 * (ratings.emotion / 5) + 0.2 * (ratings.change / 2));
  return Math.max(0, Math.min(100, Math.round(value)));
}

export const SCENE_FLAGS = [
  "repetitive",
  "no_story_change",
  "weak_transition",
  "exposition_heavy",
  "tension_drop",
  "early_resolution",
  "missing_setup_payoff",
] as const;
export type SceneFlag = (typeof SCENE_FLAGS)[number];

export const SCENE_FLAG_LABELS: Record<SceneFlag, string> = {
  repetitive: "Feels repetitive",
  no_story_change: "Doesn't move the story",
  weak_transition: "Weak transition",
  exposition_heavy: "Too much explaining",
  tension_drop: "Tension drops",
  early_resolution: "Conflict resolved too early",
  missing_setup_payoff: "Setup or payoff missing",
};

export const RECOMMENDATION_ACTIONS = [
  "discuss",
  "alternative_scene",
  "pacing",
  "opening_hook",
  "character_investment",
  "suspense",
  "emotional_payoff",
] as const;
export type RecommendationAction = (typeof RECOMMENDATION_ACTIONS)[number];

/** Actions that only ask the Creative Director (reply, no board change); the rest produce an Apply/Discard proposal. */
export const REPLY_ONLY_ACTIONS: readonly RecommendationAction[] = ["discuss", "alternative_scene"];

export const MAX_ENGAGEMENT_SCENES = 20;
export const MAX_RECOMMENDATIONS = 8;
export const MAX_KEY_FACTORS = 5;

const text = (max: number) => z.string().trim().max(max);
const refs = z.array(text(16)).max(12);

/** Measured from the plan in code, never by the AI. */
export const paceMetricsSchema = z.object({
  seconds: z.number().min(0),
  shots: z.number().int().min(0),
  averageShotSeconds: z.number().min(0),
  dialogueLines: z.number().int().min(0),
  shotsWithDialogue: z.number().int().min(0),
  characters: z.number().int().min(0),
});
export type PaceMetrics = z.infer<typeof paceMetricsSchema>;

export const sceneAssessmentSchema = z.object({
  /** "S01" — the scene's position in the plan, set in code. */
  sceneId: text(8).min(1),
  title: text(200),
  status: z.enum(["ok", "failed"]),
  summary: text(600),
  purpose: text(400),
  strengths: z.array(text(300)).max(3),
  weaknesses: z.array(text(300)).max(3),
  pacing: text(400),
  curiosity: text(300),
  emotion: text(300),
  improvements: z.array(text(400)).max(3),
  flags: z.array(z.enum(SCENE_FLAGS)).max(SCENE_FLAGS.length),
  /** Shot ids in this scene that back the assessment, e.g. "S02_SH03". */
  evidence: refs,
  ratings: sceneRatingsSchema.nullable(),
  /** scenePotential(ratings), computed in code; null when the scene couldn't be analysed. */
  potential: z.number().int().min(0).max(100).nullable(),
  metrics: paceMetricsSchema,
});
export type SceneAssessment = z.infer<typeof sceneAssessmentSchema>;

export const dimensionAssessmentSchema = z.object({
  dimension: z.enum(ENGAGEMENT_DIMENSIONS),
  /** 0–100 by the documented rubric, or null with insufficient = true when the story doesn't show it yet. */
  score: z.number().int().min(0).max(100).nullable(),
  insufficient: z.boolean(),
  explanation: text(800),
  /** Scene / shot ids from the plan that back the score. */
  evidence: refs,
});
export type DimensionAssessment = z.infer<typeof dimensionAssessmentSchema>;

export const recommendationSchema = z.object({
  id: text(16).min(1),
  priority: z.enum(["high", "medium", "low"]),
  action: z.enum(RECOMMENDATION_ACTIONS),
  sceneRefs: refs,
  problem: text(400).min(1),
  whyItMatters: text(400).min(1),
  alternative: text(600).min(1),
  benefit: text(300).min(1),
});
export type EngagementRecommendation = z.infer<typeof recommendationSchema>;

export const engagementReportSchema = z.object({
  version: z.literal(1),
  createdAt: z.number().int().positive(),
  /** planSignature() of the analysed plan; differs → out of date. */
  planSignature: text(80),
  /** overallScore() of the dimension scores and its band; null when there isn't enough evidence. */
  overall: z.object({
    score: z.number().int().min(0).max(100).nullable(),
    summary: text(800),
  }),
  keyFactors: z.array(text(300)).max(MAX_KEY_FACTORS),
  dimensions: z.array(dimensionAssessmentSchema).length(ENGAGEMENT_DIMENSIONS.length),
  /** One entry per plan scene, in plan order; the curve is scenes[i].potential. */
  scenes: z.array(sceneAssessmentSchema).max(MAX_ENGAGEMENT_SCENES),
  /** Explanations of the biggest rises and drops between consecutive scenes. */
  curveNotes: z.array(z.object({ sceneId: text(8).min(1), note: text(300).min(1) })).max(6),
  /** Computed in code from scene potentials (highest / lowest, ties in plan order). */
  strongest: z.array(text(8)).max(3),
  weakest: z.array(text(8)).max(3),
  recommendations: z.array(recommendationSchema).max(MAX_RECOMMENDATIONS),
});
export type EngagementReport = z.infer<typeof engagementReportSchema>;

export const sessionEngagementSchema = z.object({ report: engagementReportSchema });
export type SessionEngagement = z.infer<typeof sessionEngagementSchema>;

/** POST /api/story/engagement. Scene calls run in parallel (shared prefix cached), then one summary call. */
export const engagementRequestSchema = z.object({
  title: text(200).min(1),
  plan: planOutput,
  context: storyContextSchema.optional(),
  /** The filmmaker's imported story text or digest (headed by the client), when there is one. */
  source: text(26_000).optional(),
});
export type EngagementRequest = z.infer<typeof engagementRequestSchema>;

export const ENGAGEMENT_ENTRY_LABEL = "Audience Retention Predictor";
export const CURVE_LABEL = "AI-estimated engagement potential — not measured audience retention.";
export const ENGAGEMENT_DISCLAIMER =
  "This is an AI assessment of the story's engagement potential, based on a written rubric. It is not measured audience retention, viewer drop-off or a box-office prediction, and it is not trained on audience data.";
