import { z } from "zod";
import { clip, shotId } from "@/lib/agents/shared";
import {
  type DimensionAssessment,
  ENGAGEMENT_DIMENSIONS,
  type EngagementRecommendation,
  type EngagementReport,
  type EngagementRequest,
  engagementReportSchema,
  MAX_ENGAGEMENT_SCENES,
  MAX_KEY_FACTORS,
  MAX_RECOMMENDATIONS,
  overallScore,
  type PaceMetrics,
  RECOMMENDATION_ACTIONS,
  recommendationSchema,
  SCENE_FLAGS,
  type SceneAssessment,
  type SceneFlag,
  type SceneRatings,
  scenePotential,
} from "@/lib/engagement";
import { DEFAULT_FORMAT } from "@/lib/formats";
import { contextFacts, memorySection, oneLine, SECTION, section, sections, textSection } from "@/lib/server/memory-view";
import {
  type CallModel,
  deadline,
  type ModelCall,
  ModelOutputError,
  modelErrorMetadata,
  PREWARM_TIMEOUT_MS,
  prewarmPrefix,
  untilAborted,
} from "@/lib/server/openai";
import { composeInstructions } from "@/lib/server/prompts";
import { EMPTY_CONTEXT } from "@/lib/story-context";
import type { ShotPlan } from "@/lib/story-planning";
import type { UsageRecord } from "@/lib/usage";

export const ENGAGEMENT_BODY_BYTES = 1_000_000;
export const SCENE_ASSESSMENT_MAX_OUTPUT_TOKENS = 1_200;
export const SCENE_ASSESSMENT_TIMEOUT_MS = 75_000;
/** The prewarm and the parallel scene calls together; the summary call gets its own SUMMARY_TIMEOUT_MS after. */
export const SCENE_PHASE_MS = 100_000;
export const SUMMARY_MAX_OUTPUT_TOKENS = 2_500;
export const SUMMARY_TIMEOUT_MS = 75_000;
export const MAX_CURVE_NOTES = 6;
const MAX_REFS = 12;
const MAX_SCENE_ITEMS = 3;
const MAX_HIGHLIGHTS = 3;

export const ENGAGEMENT_FAILED_MESSAGE = "The engagement report couldn’t finish. Your story is unchanged — try again.";
export const NO_SCENES_MESSAGE = "Create a plan with scenes first.";
export const TOO_MANY_SCENES_MESSAGE = `The engagement report covers up to ${MAX_ENGAGEMENT_SCENES} scenes. Combine some scenes, then try again.`;
const NOT_ASSESSED = "This wasn’t assessed this time.";

export const engagementSceneOutput = z.object({
  summary: z.string(),
  purpose: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  pacing: z.string(),
  curiosity: z.string(),
  emotion: z.string(),
  improvements: z.array(z.string()),
  flags: z.array(z.enum(SCENE_FLAGS)),
  evidence: z.array(z.string()),
  ratings: z.object({ tension: z.number(), curiosity: z.number(), emotion: z.number(), change: z.number() }),
});
export type EngagementSceneOutput = z.infer<typeof engagementSceneOutput>;

export const engagementSummaryOutput = z.object({
  summary: z.string(),
  keyFactors: z.array(z.string()),
  dimensions: z.array(
    z.object({
      dimension: z.enum(ENGAGEMENT_DIMENSIONS),
      score: z.number().nullable(),
      insufficient: z.boolean(),
      explanation: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
  curveNotes: z.array(z.object({ sceneId: z.string(), note: z.string() })),
  recommendations: z.array(
    z.object({
      priority: recommendationSchema.shape.priority,
      action: z.enum(RECOMMENDATION_ACTIONS),
      sceneRefs: z.array(z.string()),
      problem: z.string(),
      whyItMatters: z.string(),
      alternative: z.string(),
      benefit: z.string(),
    }),
  ),
});
export type EngagementSummaryOutput = z.infer<typeof engagementSummaryOutput>;

// The client adds createdAt and planSignature when it stores the report.
export type EngagementCheck = Omit<EngagementReport, "createdAt" | "planSignature">;
const engagementCheckSchema = engagementReportSchema.omit({ createdAt: true, planSignature: true });

export type EngagementResult = { report: EngagementCheck; usage: UsageRecord[] };

export type EngagementOptions = {
  signal?: AbortSignal;
  prewarmTimeoutMs?: number;
  sceneTimeoutMs?: number;
  summaryTimeoutMs?: number;
};

export type EngagementFailure = "scenes" | "summary" | "report";

export class EngagementError extends Error {
  constructor(
    readonly failure: EngagementFailure,
    readonly usage: UsageRecord[],
    cause?: unknown,
  ) {
    super(`Engagement report failed (${failure})`, { cause });
    this.name = "EngagementError";
  }
}

type PlanScene = ShotPlan["scenes"][number];
type PlanShot = PlanScene["shots"][number];
type SummaryRecommendation = EngagementSummaryOutput["recommendations"][number];

export const sceneId = (index: number) => `S${String(index + 1).padStart(2, "0")}`;

/** null when the plan can be assessed; otherwise the plain 400 message. Scenes are never silently dropped. */
export function engagementInputProblem(plan: ShotPlan): string | null {
  if (!plan.scenes.length) return NO_SCENES_MESSAGE;
  if (plan.scenes.length > MAX_ENGAGEMENT_SCENES) return TOO_MANY_SCENES_MESSAGE;
  return null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const spokenLines = (shot: PlanShot) => shot.dialogue.filter(({ line }) => line.trim());

function sceneCharacters(scene: PlanScene): string[] {
  const names = new Map<string, string>();
  for (const shot of scene.shots) {
    for (const name of [...shot.characters, ...spokenLines(shot).map(({ speaker }) => speaker)]) {
      const clean = oneLine(name);
      if (clean && !names.has(clean.toLowerCase())) names.set(clean.toLowerCase(), clean);
    }
  }
  return [...names.values()];
}

/** Measured in code from the plan, never by the model. */
export function paceMetrics(scene: PlanScene): PaceMetrics {
  const seconds = round1(scene.shots.reduce((sum, shot) => sum + Math.max(0, shot.seconds), 0));
  const spoken = scene.shots.map((shot) => spokenLines(shot).length);
  return {
    seconds,
    shots: scene.shots.length,
    averageShotSeconds: scene.shots.length ? round1(seconds / scene.shots.length) : 0,
    dialogueLines: spoken.reduce((sum, count) => sum + count, 0),
    shotsWithDialogue: spoken.filter(Boolean).length,
    characters: sceneCharacters(scene).length,
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function metricsText(metrics: PaceMetrics): string {
  return [
    `${metrics.seconds} s`,
    `${plural(metrics.shots, "shot")} (about ${metrics.averageShotSeconds} s each)`,
    `${plural(metrics.dialogueLines, "dialogue line")} in ${plural(metrics.shotsWithDialogue, "shot")}`,
    plural(metrics.characters, "character"),
  ].join(", ");
}

const sceneHeading = (scene: PlanScene, index: number, metrics: PaceMetrics) =>
  `${sceneId(index)} · ${oneLine(scene.title) || "Untitled"} — ${metricsText(metrics)}`;

function filmSection(plan: ShotPlan, fallbackTitle: string): string {
  const characters = plan.characters.map(({ name, role, personality }) =>
    `- ${clip([name, role, personality].map(oneLine).filter(Boolean).join(" — "), 300)}`,
  );
  const places = plan.locations.map(({ name }) => oneLine(name)).filter(Boolean);
  return section(SECTION.film, [
    `Title: ${oneLine(plan.title) || oneLine(fallbackTitle)}`,
    plan.logline.trim() ? `Logline: ${clip(plan.logline, 600)}` : "",
    plan.intent.trim() ? `Intent: ${clip(plan.intent, 600)}` : "",
    ...(characters.length ? ["Characters:", ...characters] : []),
    places.length ? `Places: ${clip(places.join("; "), 600)}` : "",
  ].filter(Boolean));
}

function sceneOutlineLine(scene: PlanScene, index: number, metrics: PaceMetrics): string {
  const names = sceneCharacters(scene);
  const first = scene.shots[0]?.action ?? "";
  const last = scene.shots.length > 1 ? scene.shots[scene.shots.length - 1].action : "";
  return [
    sceneHeading(scene, index, metrics),
    names.length ? `Characters: ${clip(names.join(", "), 160)}` : "",
    first.trim() ? `Opens: ${clip(first, 160)}` : "",
    last.trim() ? `Ends: ${clip(last, 160)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function scenesSection(plan: ShotPlan, metrics: readonly PaceMetrics[]): string {
  return section(SECTION.scenes, plan.scenes.map((scene, index) => sceneOutlineLine(scene, index, metrics[index])));
}

export function sceneToAssessSection(plan: ShotPlan, index: number, metrics: PaceMetrics): string {
  const scene = plan.scenes[index];
  return section(SECTION.sceneToAssess, [
    sceneHeading(scene, index, metrics),
    ...scene.shots.flatMap((shot, shotIndex) => [
      `- ${[
        shotId(index, shotIndex),
        `${round1(Math.max(0, shot.seconds))} s`,
        clip(shot.action, 600),
        shot.emotion.trim() ? `Emotion: ${clip(shot.emotion, 120)}` : "",
        shot.sound.trim() ? `Sound: ${clip(shot.sound, 120)}` : "",
      ]
        .filter(Boolean)
        .join(" · ")}`,
      ...spokenLines(shot).map(({ speaker, line }) => `  ${clip(speaker, 60) || "Someone"}: ${clip(line, 300)}`),
    ]),
  ]);
}

// Unapproved AI suggestions aren't the filmmaker's story, so they can't be judged as part of it.
function confirmedMemory(request: EngagementRequest): string {
  return memorySection(contextFacts(request.context ?? EMPTY_CONTEXT).filter(({ status }) => status !== "ai_suggestion"));
}

/** Every scene call sends this first; it is what a prewarm writes to the prompt cache. */
export function sharedScenePrefix(request: EngagementRequest, metrics: readonly PaceMetrics[]): string {
  return `${sections(
    filmSection(request.plan, request.title),
    confirmedMemory(request),
    textSection(SECTION.source, request.source),
    scenesSection(request.plan, metrics),
  )}\n`;
}

const RETENTION_CLAIMS: readonly RegExp[] = [
  /%|\bper\s?cent\b|\bpercent(?:age)?s?\b/i,
  /\b\d+(?:[.,]\d+)?\s*(?:\/|out of)\s*(?:5|10|100)\b/i,
  /\bdrop[\s-]?offs?\b/i,
  /\bretention\b/i,
  /\bbox[\s-]?office\b/i,
  /\bticket sales\b/i,
  /\bgross(?:ed|es|ing)?\b/i,
  /\brevenue\b/i,
  /\bwatch[\s-]?time\b/i,
  /\bcompletion rates?\b/i,
  /\bclick[\s-]?through\b/i,
  /\bgo(?:es|ing)? viral\b/i,
  /\b(?:viewers?|audiences?|watchers?)\b[^.!?]{0,40}?\b(?:leave|leaving|stop watching|tune out|tuning out|switch off|turn off|walk out|click away|scroll away|swipe away|lose interest|losing interest|get bored|getting bored|check their phones?|drop out|abandon|give up on)\b/i,
  /\b(?:viewers?|audiences?)\s+(?:will|would|are going to)\s+(?:love|hate|enjoy|stay|keep watching|watch|share|come back|return|binge)\b/i,
];

export function withoutRetentionClaims(text: string): string {
  return oneLine(text)
    .split(/(?<=[.!?…])\s+/)
    .filter((sentence) => !RETENTION_CLAIMS.some((pattern) => pattern.test(sentence)))
    .join(" ")
    .trim();
}

const plain = (text: string, max: number) => clip(withoutRetentionClaims(text), max);

function plainList(items: readonly string[], maxItems: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const item of items) {
    const text = plain(item, maxChars);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    kept.push(text);
    if (kept.length === maxItems) break;
  }
  return kept;
}

type PlanRef = { id: string; scene: number; shot: number | null };

const REF = /^S(?:CENE)?[\s_-]*0*(\d{1,3})(?:[\s_-]*SH(?:OT)?[\s_-]*0*(\d{1,3}))?$/i;

export function parsePlanRef(ref: string, plan: ShotPlan): PlanRef | null {
  const match = REF.exec(ref.trim());
  if (!match) return null;
  const sceneIndex = Number(match[1]) - 1;
  const scene = plan.scenes[sceneIndex];
  if (!scene) return null;
  if (match[2] === undefined) return { id: sceneId(sceneIndex), scene: sceneIndex, shot: null };
  const shotIndex = Number(match[2]) - 1;
  return scene.shots[shotIndex] ? { id: shotId(sceneIndex, shotIndex), scene: sceneIndex, shot: shotIndex } : null;
}

function planRefs(refs: readonly string[], plan: ShotPlan, keep: (ref: PlanRef) => boolean = () => true): string[] {
  const ids = new Set<string>();
  for (const raw of refs) {
    const ref = parsePlanRef(raw, plan);
    if (ref && keep(ref)) ids.add(ref.id);
    if (ids.size === MAX_REFS) break;
  }
  return [...ids];
}

const clampInt = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

function cleanRatings(ratings: EngagementSceneOutput["ratings"]): SceneRatings {
  return {
    tension: clampInt(ratings.tension, 1, 5),
    curiosity: clampInt(ratings.curiosity, 1, 5),
    emotion: clampInt(ratings.emotion, 1, 5),
    change: clampInt(ratings.change, 0, 2),
  };
}

function assessedScene(plan: ShotPlan, index: number, metrics: PaceMetrics, output: EngagementSceneOutput): SceneAssessment {
  const ratings = cleanRatings(output.ratings);
  return {
    sceneId: sceneId(index),
    title: clip(plan.scenes[index].title, 200),
    status: "ok",
    summary: plain(output.summary, 600),
    purpose: plain(output.purpose, 400),
    strengths: plainList(output.strengths, MAX_SCENE_ITEMS, 300),
    weaknesses: plainList(output.weaknesses, MAX_SCENE_ITEMS, 300),
    pacing: plain(output.pacing, 400),
    curiosity: plain(output.curiosity, 300),
    emotion: plain(output.emotion, 300),
    improvements: plainList(output.improvements, MAX_SCENE_ITEMS, 400),
    flags: [...new Set<SceneFlag>(output.flags)],
    evidence: planRefs(output.evidence, plan, (ref) => ref.scene === index && ref.shot !== null),
    ratings,
    potential: scenePotential(ratings),
    metrics,
  };
}

function failedScene(plan: ShotPlan, index: number, metrics: PaceMetrics): SceneAssessment {
  return {
    sceneId: sceneId(index),
    title: clip(plan.scenes[index].title, 200),
    status: "failed",
    summary: "",
    purpose: "",
    strengths: [],
    weaknesses: [],
    pacing: "",
    curiosity: "",
    emotion: "",
    improvements: [],
    flags: [],
    evidence: [],
    ratings: null,
    potential: null,
    metrics,
  };
}

/** Top and bottom scenes by potential, ties in plan order; never overlapping, empty below two analysed scenes. */
export function highlightScenes(scenes: readonly SceneAssessment[]): { strongest: string[]; weakest: string[] } {
  const analysed = scenes
    .map((scene, order) => ({ id: scene.sceneId, potential: scene.potential, order }))
    .filter((scene): scene is { id: string; potential: number; order: number } => scene.potential !== null);
  const count = Math.min(MAX_HIGHLIGHTS, Math.floor(analysed.length / 2));
  if (!count) return { strongest: [], weakest: [] };
  const strongest = [...analysed].sort((a, b) => b.potential - a.potential || a.order - b.order).slice(0, count);
  const taken = new Set(strongest.map(({ id }) => id));
  const weakest = analysed
    .filter(({ id }) => !taken.has(id))
    .sort((a, b) => a.potential - b.potential || a.order - b.order)
    .slice(0, count);
  return { strongest: strongest.map(({ id }) => id), weakest: weakest.map(({ id }) => id) };
}

const sceneResultLines = (scene: SceneAssessment, heading: string): string[] => {
  if (scene.status === "failed" || !scene.ratings) return [`${heading} — not assessed (this scene couldn’t be analysed)`];
  const list = (items: readonly string[]) => items.join("; ");
  const { tension, curiosity, emotion, change } = scene.ratings;
  return [
    heading,
    scene.summary ? `Summary: ${scene.summary}` : "",
    scene.purpose ? `Purpose: ${scene.purpose}` : "",
    scene.strengths.length ? `Strengths: ${list(scene.strengths)}` : "",
    scene.weaknesses.length ? `Weaknesses: ${list(scene.weaknesses)}` : "",
    scene.pacing ? `Pacing: ${scene.pacing}` : "",
    scene.curiosity ? `Curiosity: ${scene.curiosity}` : "",
    scene.emotion ? `Emotion: ${scene.emotion}` : "",
    scene.improvements.length ? `Improvements: ${list(scene.improvements)}` : "",
    scene.flags.length ? `Flags: ${scene.flags.join(", ")}` : "",
    scene.evidence.length ? `Evidence: ${scene.evidence.join(", ")}` : "",
    `Ratings: tension ${tension}, curiosity ${curiosity}, emotion ${emotion}, change ${change}; potential ${scene.potential}`,
  ].filter(Boolean);
};

/** The summary call's input: the scene results and metrics, not the plan again. */
export function summaryInput(request: EngagementRequest, scenes: readonly SceneAssessment[]): string {
  return sections(
    filmSection(request.plan, request.title),
    confirmedMemory(request),
    section(
      SECTION.sceneAssessments,
      scenes.flatMap((scene, index) =>
        sceneResultLines(scene, sceneHeading(request.plan.scenes[index], index, scene.metrics)),
      ),
    ),
  );
}

export function cleanDimensions(raw: EngagementSummaryOutput["dimensions"], plan: ShotPlan): DimensionAssessment[] {
  return ENGAGEMENT_DIMENSIONS.map((dimension) => {
    const found = raw.find((entry) => entry.dimension === dimension);
    if (!found) return { dimension, score: null, insufficient: true, explanation: NOT_ASSESSED, evidence: [] };
    const evidence = planRefs(found.evidence, plan);
    // A score with no real evidence behind it is a guess: report it as insufficient instead.
    const scored = !found.insufficient && found.score !== null && evidence.length > 0;
    return {
      dimension,
      score: scored && found.score !== null ? clampInt(found.score, 0, 100) : null,
      insufficient: !scored,
      explanation: plain(found.explanation, 800),
      evidence,
    };
  });
}

function cleanCurveNotes(raw: EngagementSummaryOutput["curveNotes"], plan: ShotPlan): EngagementReport["curveNotes"] {
  const seen = new Set<string>();
  const notes: EngagementReport["curveNotes"] = [];
  for (const entry of raw) {
    const ref = parsePlanRef(entry.sceneId, plan);
    const note = plain(entry.note, 300);
    if (!ref || !note) continue;
    const id = sceneId(ref.scene);
    if (seen.has(id)) continue;
    seen.add(id);
    notes.push({ sceneId: id, note });
    if (notes.length === MAX_CURVE_NOTES) break;
  }
  return notes;
}

/**
 * The only flags that can justify removing a scene: it repeats another, changes nothing, or only explains. Low tension,
 * quietness, a weak transition, an early resolution or a missing payoff call for a change to the scene, not its removal.
 */
export const REMOVAL_REASONS: readonly SceneFlag[] = ["repetitive", "no_story_change", "exposition_heavy"];

const REMOVE_VERB = "(?:remov(?:e|ing)|cut(?:ting)?|delet(?:e|ing)|drop(?:ping)?|omit(?:ting)?|eliminat(?:e|ing)|scrap(?:ping)?|skip(?:ping)?|get(?:ting)? rid of)";
const REMOVED = "(?:removed|cut|deleted|dropped|omitted|eliminated|scrapped|skipped)";
// Prepositions and trims between the verb and the scene mean "cut to the next scene", "a drop in S03" or "cut S03 down".
const FILLER = String.raw`(?:\s+(?!(?:in|at|of|to|into|from|between|during|after|before|for|with|by|on|across|through|within|where|when|down|back|short)\b)[\w'’-]+){0,3}?`;
const TARGET = String.raw`(?<target>S(?:cene)?[\s_-]*\d{1,3}\b(?![\s_-]*SH)|scenes?\b)`;
const NOT_TRIM = String.raw`(?!\s+(?:down|back|short|shorter|to|into)\b)`;
const REMOVAL_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${REMOVE_VERB}\b${FILLER}\s+${TARGET}${NOT_TRIM}`, "gi"),
  new RegExp(String.raw`${TARGET}${FILLER}\s+(?:be|is|are|being|gets?|got)\s+${REMOVED}\b${NOT_TRIM}`, "gi"),
];

/** Scenes a recommendation proposes removing: named ids, or its sceneRefs when it says "this scene". null: no removal. */
export function removalTargets(recommendation: SummaryRecommendation, plan: ShotPlan): number[] | null {
  const referenced = [...new Set(recommendation.sceneRefs.map((ref) => parsePlanRef(ref, plan)?.scene).filter((scene) => scene !== undefined))];
  const targets = new Set<number>();
  let removes = false;
  for (const text of [recommendation.problem, recommendation.alternative]) {
    for (const pattern of REMOVAL_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        removes = true;
        const named = parsePlanRef(match.groups?.target ?? "", plan);
        for (const scene of named ? [named.scene] : referenced) targets.add(scene);
      }
    }
  }
  return removes ? [...targets] : null;
}

const removalJustified = (scene: SceneAssessment | undefined) =>
  scene?.status === "ok" && scene.flags.some((flag) => REMOVAL_REASONS.includes(flag));

const mentionsRemoval = (text: string) => REMOVAL_PATTERNS.some((pattern) => new RegExp(pattern.source, "i").test(text));

export const QUIET_SCENE_TEXT = {
  problem: "This scene is quiet and low in tension.",
  whyItMatters: "A quiet scene can carry feeling and give the film room to breathe, so it is worth keeping when its purpose is clear.",
  alternative:
    "Keep the scene, but give it a clear purpose: a small decision, a new piece of information or a moment that shows how a character feels.",
  benefit: "The film keeps its change of pace, and the quiet scene still moves the story.",
} as const;

type GuardResult = { recommendations: SummaryRecommendation[]; rewritten: number; dropped: number };

/**
 * A recommendation that proposes removing a scene stands only when every scene it would remove was assessed and
 * flagged with one of REMOVAL_REASONS (and it names at least one). Otherwise it is rewritten into a low-priority
 * "alternative_scene" suggestion that keeps the scene (its problem kept unless it too proposes removal), or dropped
 * when another recommendation already covers every scene it would remove.
 */
export function guardQuietScenes(
  recommendations: readonly SummaryRecommendation[],
  scenes: readonly SceneAssessment[],
  plan: ShotPlan,
): GuardResult {
  const checked = recommendations.map((recommendation) => {
    const targets = removalTargets(recommendation, plan);
    const guarded = targets !== null && (!targets.length || !targets.every((scene) => removalJustified(scenes[scene])));
    return { recommendation, targets: targets ?? [], guarded };
  });
  const covered = new Set(
    checked
      .filter(({ guarded }) => !guarded)
      .flatMap(({ recommendation }) => recommendation.sceneRefs.map((ref) => parsePlanRef(ref, plan)?.scene)),
  );
  let rewritten = 0;
  let dropped = 0;
  const kept: SummaryRecommendation[] = [];
  for (const { recommendation, targets, guarded } of checked) {
    if (!guarded) {
      kept.push(recommendation);
      continue;
    }
    if (targets.length && targets.every((scene) => covered.has(scene))) {
      dropped += 1;
      continue;
    }
    rewritten += 1;
    kept.push({
      priority: "low",
      action: "alternative_scene",
      sceneRefs: targets.length ? targets.map(sceneId) : recommendation.sceneRefs,
      problem: mentionsRemoval(recommendation.problem) ? QUIET_SCENE_TEXT.problem : recommendation.problem,
      whyItMatters: QUIET_SCENE_TEXT.whyItMatters,
      alternative: QUIET_SCENE_TEXT.alternative,
      benefit: QUIET_SCENE_TEXT.benefit,
    });
  }
  return { recommendations: kept, rewritten, dropped };
}

const PRIORITY_RANK: Record<EngagementRecommendation["priority"], number> = { high: 0, medium: 1, low: 2 };

export function cleanRecommendations(
  raw: readonly SummaryRecommendation[],
  scenes: readonly SceneAssessment[],
  plan: ShotPlan,
): { recommendations: EngagementRecommendation[]; rewritten: number; dropped: number } {
  const guarded = guardQuietScenes(raw, scenes, plan);
  const cleaned = guarded.recommendations
    .map((recommendation) => ({
      priority: recommendation.priority,
      action: recommendation.action,
      sceneRefs: planRefs(recommendation.sceneRefs, plan),
      problem: plain(recommendation.problem, 400),
      whyItMatters: plain(recommendation.whyItMatters, 400),
      alternative: plain(recommendation.alternative, 600),
      benefit: plain(recommendation.benefit, 300),
    }))
    .filter(({ problem, whyItMatters, alternative, benefit }) => problem && whyItMatters && alternative && benefit);
  const recommendations = cleaned
    .map((recommendation, order) => ({ recommendation, order }))
    .sort((a, b) => PRIORITY_RANK[a.recommendation.priority] - PRIORITY_RANK[b.recommendation.priority] || a.order - b.order)
    .slice(0, MAX_RECOMMENDATIONS)
    .map(({ recommendation }, index) => ({ id: `R${String(index + 1).padStart(2, "0")}`, ...recommendation }));
  return { recommendations, rewritten: guarded.rewritten, dropped: guarded.dropped + (guarded.recommendations.length - cleaned.length) };
}

/** Builds the report in code from the scene results and the summary; the model never sets the overall score. */
export function assembleReport(
  plan: ShotPlan,
  scenes: readonly SceneAssessment[],
  summary: EngagementSummaryOutput,
): { report: EngagementCheck; rewritten: number; dropped: number } {
  const dimensions = cleanDimensions(summary.dimensions, plan);
  const { recommendations, rewritten, dropped } = cleanRecommendations(summary.recommendations, scenes, plan);
  const report: EngagementCheck = {
    version: 1,
    overall: {
      score: overallScore(Object.fromEntries(dimensions.map(({ dimension, score }) => [dimension, score]))),
      summary: plain(summary.summary, 800),
    },
    keyFactors: plainList(summary.keyFactors, MAX_KEY_FACTORS, 300),
    dimensions,
    scenes: [...scenes],
    curveNotes: cleanCurveNotes(summary.curveNotes, plan),
    ...highlightScenes(scenes),
    recommendations,
  };
  return { report, rewritten, dropped };
}

type SceneCall = Omit<ModelCall, "input" | "cachedPrefix" | "signal" | "timeoutMs">;

type SceneOutcome =
  | { ok: true; output: EngagementSceneOutput; usage: UsageRecord }
  | { ok: false; error: unknown; usage?: UsageRecord };

async function assessScene(
  request: EngagementRequest,
  index: number,
  metrics: PaceMetrics,
  call: SceneCall,
  shared: { prefix: string; cached: boolean },
  callModel: CallModel,
  timeoutMs: number,
  parent: AbortSignal | undefined,
): Promise<SceneOutcome> {
  try {
    const signal = deadline(parent, timeoutMs);
    const own = sceneToAssessSection(request.plan, index, metrics);
    const input = shared.cached ? { cachedPrefix: shared.prefix, input: own } : { input: `${shared.prefix}${own}` };
    const result = await untilAborted(callModel({ ...call, ...input, signal, timeoutMs }), signal);
    const parsed = engagementSceneOutput.safeParse(result.output);
    if (!parsed.success) throw new ModelOutputError(`Invalid engagement assessment for scene ${index + 1}`, result.usage, "invalid_output");
    return { ok: true, output: parsed.data, usage: result.usage };
  } catch (error) {
    console.warn("Engagement scene failed", { scene: index + 1, ...modelErrorMetadata(error) });
    return { ok: false, error, ...(error instanceof ModelOutputError ? { usage: error.usage } : {}) };
  }
}

async function summarise(
  callModel: CallModel,
  input: string,
  options: EngagementOptions,
): Promise<{ output: EngagementSummaryOutput; usage: UsageRecord }> {
  const timeoutMs = options.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS;
  const signal = deadline(options.signal, timeoutMs);
  const result = await untilAborted(
    callModel({
      step: "engagement",
      stage: "engagement_summary",
      instructions: composeInstructions("engagement_summary", DEFAULT_FORMAT),
      input,
      schema: engagementSummaryOutput,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      signal,
      timeoutMs,
    }),
    signal,
  );
  const parsed = engagementSummaryOutput.safeParse(result.output);
  if (!parsed.success) throw new ModelOutputError("Invalid engagement summary", result.usage, "invalid_output");
  return { output: parsed.data, usage: result.usage };
}

/** A failed scene doesn't fail the report unless more than half fail. Bounded at 2 + MAX_ENGAGEMENT_SCENES calls. */
export async function runEngagement(
  request: EngagementRequest,
  callModel: CallModel,
  options: EngagementOptions = {},
): Promise<EngagementResult> {
  const started = Date.now();
  const { plan } = request;
  const problem = engagementInputProblem(plan);
  if (problem) throw new Error(problem);
  const metrics = plan.scenes.map(paceMetrics);

  const call: SceneCall = {
    step: "engagement",
    stage: "engagement_scene",
    instructions: composeInstructions("engagement_scene", DEFAULT_FORMAT),
    schema: engagementSceneOutput,
    maxOutputTokens: SCENE_ASSESSMENT_MAX_OUTPUT_TOKENS,
  };
  const prefix = sharedScenePrefix(request, metrics);
  const prewarmTimeoutMs = options.prewarmTimeoutMs ?? PREWARM_TIMEOUT_MS;
  const prewarm = await prewarmPrefix(
    callModel,
    { ...call, cachedPrefix: prefix, signal: deadline(options.signal, prewarmTimeoutMs), timeoutMs: prewarmTimeoutMs },
    plan.scenes.length,
  );
  // The prewarm runs inside the scene phase so prewarm + scenes + summary still fit the route's maxDuration.
  const sceneTimeoutMs = Math.max(
    1,
    Math.min(options.sceneTimeoutMs ?? SCENE_ASSESSMENT_TIMEOUT_MS, SCENE_PHASE_MS - (Date.now() - started)),
  );
  const shared = { prefix, cached: prewarm.cachedPrefix !== undefined };
  const outcomes = await Promise.all(
    plan.scenes.map((_, index) =>
      assessScene(request, index, metrics[index], call, shared, callModel, sceneTimeoutMs, options.signal),
    ),
  );

  const usage: UsageRecord[] = [
    ...(prewarm.usage ? [prewarm.usage] : []),
    ...outcomes.flatMap((outcome) => (outcome.usage ? [outcome.usage] : [])),
  ];
  const failed = outcomes.filter((outcome): outcome is Extract<SceneOutcome, { ok: false }> => !outcome.ok);
  if (failed.length * 2 > outcomes.length) throw new EngagementError("scenes", usage, failed[0].error);
  const scenes = outcomes.map((outcome, index) =>
    outcome.ok ? assessedScene(plan, index, metrics[index], outcome.output) : failedScene(plan, index, metrics[index]),
  );

  let summary: EngagementSummaryOutput;
  try {
    const result = await summarise(callModel, summaryInput(request, scenes), options);
    usage.push(result.usage);
    summary = result.output;
  } catch (error) {
    if (error instanceof ModelOutputError) usage.push(error.usage);
    throw new EngagementError("summary", usage, error);
  }

  const { report, rewritten, dropped } = assembleReport(plan, scenes, summary);
  const checked = engagementCheckSchema.safeParse(report);
  if (!checked.success) throw new EngagementError("report", usage, checked.error);

  console.info("Engagement report", {
    ms: Date.now() - started,
    scenes: scenes.length,
    failedScenes: failed.length,
    prewarmed: shared.cached,
    scoredDimensions: report.dimensions.filter(({ score }) => score !== null).length,
    overall: report.overall.score,
    recommendations: report.recommendations.length,
    rewrittenRecommendations: rewritten,
    droppedRecommendations: dropped,
  });
  return { report: checked.data, usage };
}
