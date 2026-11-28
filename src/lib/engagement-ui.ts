import {
  bandFor,
  type DimensionAssessment,
  ENGAGEMENT_ENTRY_LABEL,
  type EngagementRecommendation,
  type EngagementReport,
  type PaceMetrics,
  REPLY_ONLY_ACTIONS,
  type RecommendationAction,
  type SceneAssessment,
} from "@/lib/engagement";
import { decidedFactsIn } from "@/lib/originality-ui";
import type { ContextFact, StoryCategoryId, StoryContext } from "@/lib/story-context";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/story-input";

export const ENGAGEMENT_COPY = {
  panelTitle: ENGAGEMENT_ENTRY_LABEL,
  subtitle: "AI-estimated engagement potential of your story — based on the plan, not on audience data.",
  run: "Run analysis",
  rerun: "Re-run analysis",
  retry: "Try again",
  running: "Analysing your story scene by scene… This takes about 30–40 seconds.",
  finished: "Analysis complete. The report is below.",
  close: "Close",
  outOfDate: "Out of date — your story changed since this analysis",
  staleEdit: "Re-run first: your story changed since this analysis, so these scenes may have moved.",
  overallHeading: "Overall",
  noOverall: "Not enough evidence for an overall score",
  keyFactors: "What shapes this most",
  dimensionsHeading: "What holds attention",
  notEnoughEvidence: "Not enough evidence",
  basedOn: "Based on",
  curveHeading: "Engagement curve",
  showTable: "Show as table",
  hideTable: "Hide table",
  tableScene: "Scene",
  tableTitle: "Title",
  tableScore: "Score",
  tableNote: "Note",
  legendStrongest: "Strongest",
  legendWeakest: "Weakest",
  legendOther: "Other scenes",
  legendGap: "Couldn’t analyse",
  curveNotesHeading: "Notes on the curve",
  strongestHeading: "Strongest scenes",
  weakestHeading: "Weakest scenes",
  noneListed: "None to show.",
  scenesHeading: "Scene by scene",
  sceneSummary: "What happens",
  scenePurpose: "Why it’s there",
  sceneStrengths: "What works",
  sceneWeaknesses: "What’s weaker",
  scenePacing: "Pacing",
  sceneCuriosity: "Curiosity",
  sceneEmotion: "Emotion",
  sceneFlags: "Watch out for",
  sceneImprovements: "Ideas to improve",
  scenePotential: "Engagement potential",
  sceneEvidence: "Shots this is based on",
  sceneFailed: "Couldn’t analyse this scene — re-run to try again.",
  notAnalysed: "Not analysed",
  recommendationsHeading: "What to improve first",
  noRecommendations: "No changes suggested.",
  recScenes: "Scenes",
  recProblem: "The problem",
  recWhy: "Why it matters",
  recAlternative: "Try this",
  recBenefit: "What it could improve",
} as const;

export function analysedAtLabel(date: string): string {
  return `Analysed ${date}`;
}

export function scoreLabel(score: number): string {
  return `${score} · ${bandFor(score)}`;
}

export function overallLabel(score: number | null): string {
  return score === null ? ENGAGEMENT_COPY.noOverall : scoreLabel(score);
}

export function dimensionScoreLabel(dimension: Pick<DimensionAssessment, "score" | "insufficient">): string {
  return dimension.score === null || dimension.insufficient ? ENGAGEMENT_COPY.notEnoughEvidence : scoreLabel(dimension.score);
}

/** A scene's curve value; null when it couldn't be analysed. */
export function scenePotentialValue(scene: Pick<SceneAssessment, "status" | "potential">): number | null {
  return scene.status === "ok" && scene.potential !== null ? scene.potential : null;
}

export function potentialLabel(scene: Pick<SceneAssessment, "status" | "potential">): string {
  const value = scenePotentialValue(scene);
  return value === null ? ENGAGEMENT_COPY.notAnalysed : scoreLabel(value);
}

export type BandTone = "strong" | "solid" | "mixed" | "weak" | "very-weak" | "none";

export function bandTone(score: number | null): BandTone {
  if (score === null) return "none";
  return bandFor(score).toLowerCase().replace(" ", "-") as BandTone;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Measured pace in plain words, e.g. "62 s · 9 shots · 4 lines of dialogue". */
export function metricsLabel(metrics: Pick<PaceMetrics, "seconds" | "shots" | "dialogueLines">): string {
  const dialogue = metrics.dialogueLines === 0 ? "no dialogue" : plural(metrics.dialogueLines, "line of dialogue", "lines of dialogue");
  return [`${Math.round(metrics.seconds)} s`, plural(metrics.shots, "shot", "shots"), dialogue].join(" · ");
}

export function sceneHeading(scene: Pick<SceneAssessment, "sceneId" | "title">): string {
  return scene.title.trim() ? `${scene.sceneId} · ${scene.title.trim()}` : scene.sceneId;
}

export function uniqueRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
}

/** The scenes named in a strongest/weakest list, in list order; unknown ids are left out. */
export function scenesByIds(scenes: readonly SceneAssessment[], ids: readonly string[]): SceneAssessment[] {
  return uniqueRefs(ids)
    .map((id) => scenes.find((scene) => scene.sceneId === id))
    .filter((scene): scene is SceneAssessment => scene !== undefined);
}

export const CURVE_SIZE = { width: 400, height: 224 } as const;
const CURVE_PLOT = { left: 34, right: 12, top: 34, bottom: 186, inset: 12 } as const;
const CURVE_TICKS = [0, 25, 50, 75, 100] as const;
const MAX_X_LABELS = 10;

export type CurveTone = "normal" | "strongest" | "weakest" | "gap";
export type CurvePoint = {
  sceneId: string;
  title: string;
  value: number | null;
  x: number;
  /** null for a scene that couldn't be analysed: the line breaks there. */
  y: number | null;
  tone: CurveTone;
  showLabel: boolean;
  /** Where the value label goes for a highlighted point; null when the point gets no label. */
  labelY: number | null;
};
export type CurveMarker = { sceneId: string; x: number; y: number | null; label: string };
export type CurveGeometry = {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  ticks: { value: number; y: number }[];
  points: CurvePoint[];
  /** SVG path data, one per run of consecutive analysed scenes. */
  segments: string[];
  markers: CurveMarker[];
};

const round1 = (value: number) => Math.round(value * 10) / 10;

export function curveY(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return round1(CURVE_PLOT.bottom - (clamped / 100) * (CURVE_PLOT.bottom - CURVE_PLOT.top));
}

function curveX(index: number, count: number): number {
  const start = CURVE_PLOT.left + CURVE_PLOT.inset;
  const end = CURVE_SIZE.width - CURVE_PLOT.right - CURVE_PLOT.inset;
  return round1(count <= 1 ? (start + end) / 2 : start + (index * (end - start)) / (count - 1));
}

// Weakest labels sit below the point and strongest above, flipping when they would hit the axis or the note markers.
function valueLabelY(y: number, below: boolean): number {
  const under = y + 16;
  const over = y - 10;
  if (below) return under <= CURVE_PLOT.bottom - 4 ? under : over;
  return over >= CURVE_PLOT.top ? over : under;
}

/** Chart geometry in plan order: x = scene position, y = 0–100 potential; failed scenes are gaps. */
export function curveGeometry(report: Pick<EngagementReport, "scenes" | "strongest" | "weakest" | "curveNotes">): CurveGeometry {
  const strongest = new Set(report.strongest);
  const weakest = new Set(report.weakest);
  const count = report.scenes.length;
  const labelStep = Math.max(1, Math.ceil(count / MAX_X_LABELS));
  const points: CurvePoint[] = report.scenes.map((scene, index) => {
    const value = scenePotentialValue(scene);
    const tone: CurveTone =
      value === null ? "gap" : strongest.has(scene.sceneId) ? "strongest" : weakest.has(scene.sceneId) ? "weakest" : "normal";
    const y = value === null ? null : curveY(value);
    return {
      sceneId: scene.sceneId,
      title: scene.title,
      value,
      x: curveX(index, count),
      y,
      tone,
      showLabel: index % labelStep === 0,
      labelY: y === null || tone === "normal" || tone === "gap" ? null : valueLabelY(y, tone === "weakest"),
    };
  });

  const segments: string[] = [];
  let run: CurvePoint[] = [];
  for (const point of [...points, null]) {
    if (point && point.y !== null) {
      run = [...run, point];
      continue;
    }
    if (run.length > 1) segments.push(run.map((item, index) => `${index === 0 ? "M" : "L"}${item.x} ${item.y}`).join(" "));
    run = [];
  }

  const numbers = new Map<string, number[]>();
  report.curveNotes.forEach((note, index) => {
    numbers.set(note.sceneId, [...(numbers.get(note.sceneId) ?? []), index + 1]);
  });
  const markers: CurveMarker[] = [...numbers.entries()].flatMap(([sceneId, list]) => {
    const point = points.find((item) => item.sceneId === sceneId);
    return point ? [{ sceneId, x: point.x, y: point.y, label: list.join(",") }] : [];
  });

  return {
    width: CURVE_SIZE.width,
    height: CURVE_SIZE.height,
    plot: {
      left: CURVE_PLOT.left,
      right: CURVE_SIZE.width - CURVE_PLOT.right,
      top: CURVE_PLOT.top,
      bottom: CURVE_PLOT.bottom,
    },
    ticks: CURVE_TICKS.map((value) => ({ value, y: curveY(value) })),
    points,
    segments,
    markers,
  };
}

/** A short spoken summary of the chart; the table holds every value. */
export function curveSummary(points: readonly CurvePoint[]): string {
  const scored = points.filter((point): point is CurvePoint & { value: number } => point.value !== null);
  const parts = [`Line chart of engagement potential from 0 to 100 across ${plural(points.length, "scene", "scenes")}.`];
  if (scored.length > 0) {
    const high = scored.reduce((best, point) => (point.value > best.value ? point : best));
    const low = scored.reduce((worst, point) => (point.value < worst.value ? point : worst));
    parts.push(`Highest: ${high.sceneId} at ${high.value}. Lowest: ${low.sceneId} at ${low.value}.`);
  }
  const gaps = points.length - scored.length;
  if (gaps > 0) parts.push(`${plural(gaps, "scene", "scenes")} couldn’t be analysed.`);
  return parts.join(" ");
}

export const PRIORITY_ORDER = ["high", "medium", "low"] as const;
export type RecommendationPriority = (typeof PRIORITY_ORDER)[number];
export const PRIORITY_LABELS: Record<RecommendationPriority, string> = { high: "High", medium: "Medium", low: "Low" };

export type PriorityGroup = { priority: RecommendationPriority; recommendations: EngagementRecommendation[] };

/** High → Medium → Low, report order within each; empty groups left out. */
export function groupRecommendations(recommendations: readonly EngagementRecommendation[]): PriorityGroup[] {
  return PRIORITY_ORDER.map((priority) => ({
    priority,
    recommendations: recommendations.filter((item) => item.priority === priority),
  })).filter((group) => group.recommendations.length > 0);
}

export type EditAction = Exclude<RecommendationAction, "discuss" | "alternative_scene">;

export function isEditAction(action: RecommendationAction): action is EditAction {
  return !REPLY_ONLY_ACTIONS.includes(action);
}

/** Every recommendation can be discussed; most also carry their own action. */
export function recommendationActions(recommendation: Pick<EngagementRecommendation, "action">): RecommendationAction[] {
  return recommendation.action === "discuss" ? ["discuss"] : ["discuss", recommendation.action];
}

export const RECOMMENDATION_ACTION_LABELS: Record<RecommendationAction, string> = {
  discuss: "Discuss with Creative Director",
  alternative_scene: "Suggest alternative scene",
  pacing: "Improve pacing",
  opening_hook: "Strengthen opening hook",
  character_investment: "Increase character investment",
  suspense: "Improve suspense",
  emotional_payoff: "Improve emotional payoff",
};

export const RECOMMENDATION_ACTION_HINTS = {
  reply: "Ask the Creative Director in the chat. Nothing on your board changes.",
  edit: "Ask the Creative Director to revise only these scenes. You’ll see the changes first and choose Apply or Discard.",
} as const;

export function recommendationActionHint(action: RecommendationAction): string {
  return isEditAction(action) ? RECOMMENDATION_ACTION_HINTS.edit : RECOMMENDATION_ACTION_HINTS.reply;
}

/** StoryContext categories each revision may touch; decided facts there are confirmed first. */
export const ACTION_FACT_CATEGORIES: Record<EditAction, readonly StoryCategoryId[]> = {
  opening_hook: ["concept", "structure"],
  character_investment: ["characters", "relationships"],
  suspense: ["structure", "scenes"],
  pacing: ["structure", "scenes"],
  emotional_payoff: ["intent", "structure"],
};

export function decidedFactsForAction(context: StoryContext | undefined, action: RecommendationAction): ContextFact[] {
  return isEditAction(action) ? decidedFactsIn(context, ACTION_FACT_CATEGORIES[action]) : [];
}

const EDIT_GOALS: Record<EditAction, string> = {
  pacing: "improve the pacing",
  opening_hook: "make the opening grab attention sooner",
  character_investment: "make the audience care more about the characters",
  suspense: "build more suspense",
  emotional_payoff: "make the emotional payoff land harder",
};

const MAX_REF_TITLE = 60;
const KEEP_BOARD = "Don’t change the board yet.";
const KEEP_REST = "Keep everything else as it is.";

type SceneTitles = readonly Pick<SceneAssessment, "sceneId" | "title">[];

function describeRefs(refs: readonly string[], scenes: SceneTitles): string {
  return uniqueRefs(refs)
    .map((ref) => {
      const title = scenes.find((scene) => scene.sceneId === ref)?.title.trim() ?? "";
      return title ? `${ref} “${title.length > MAX_REF_TITLE ? `${title.slice(0, MAX_REF_TITLE - 1).trimEnd()}…` : title}”` : ref;
    })
    .join(", ");
}

/** Keeps the closing instruction whole when the message has to be shortened. */
function withClosing(body: readonly string[], closing: string): string {
  const room = MAX_CHAT_MESSAGE_CHARACTERS - closing.length - 2;
  const text = body.join("\n\n");
  const fitted = text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text;
  return `${fitted}\n\n${closing}`;
}

export type RecommendationRequest = { message: string; intent?: "edit" };

/** The chat request an action sends to the Creative Director; it always names the scenes, the problem and the suggestion. */
export function recommendationRequest(
  action: RecommendationAction,
  recommendation: EngagementRecommendation,
  scenes: SceneTitles = [],
): RecommendationRequest {
  const refs = describeRefs(recommendation.sceneRefs, scenes);
  if (isEditAction(action)) {
    const onlyScenes = uniqueRefs(recommendation.sceneRefs).every((ref) => /^S\d+$/.test(ref));
    const target = refs ? `Revise only these ${onlyScenes ? "scenes" : "parts"}: ${refs}.` : "Revise only the scenes this note is about.";
    return {
      intent: "edit",
      message: withClosing(
        [
          `${target} Goal: ${EDIT_GOALS[action]}. Follow this suggestion: ${recommendation.alternative}`,
          `Problem to fix: ${recommendation.problem}`,
        ],
        KEEP_REST,
      ),
    };
  }
  const details = [
    `Scenes: ${refs || "not named"}`,
    `Problem: ${recommendation.problem}`,
    `Why it matters: ${recommendation.whyItMatters}`,
  ];
  if (action === "alternative_scene") {
    return {
      message: withClosing(
        [
          "My story’s engagement analysis suggests trying a different version of a scene. What do you think would work instead? Suggest 2–3 alternative versions in plain words so I can choose.",
          [...details, `The analysis suggested: ${recommendation.alternative}`].join("\n"),
        ],
        KEEP_BOARD,
      ),
    };
  }
  return {
    message: withClosing(
      [
        "My story’s engagement analysis raised this. I’d like your view before changing anything.",
        [...details, `Suggested change: ${recommendation.alternative}`, `Expected benefit: ${recommendation.benefit}`].join("\n"),
        "What do you think: does it matter for my film, and what are my options?",
      ],
      KEEP_BOARD,
    ),
  };
}
