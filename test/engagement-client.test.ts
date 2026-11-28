import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { selectSpecialists } from "../src/lib/agents/router.ts";
import {
  ENGAGEMENT_DIMENSIONS,
  ENGAGEMENT_ENTRY_LABEL,
  type EngagementRecommendation,
  type EngagementReport,
  RECOMMENDATION_ACTIONS,
  type RecommendationAction,
  type SceneAssessment,
} from "../src/lib/engagement.ts";
import {
  ACTION_FACT_CATEGORIES,
  analysedAtLabel,
  bandTone,
  CURVE_SIZE,
  curveGeometry,
  curveSummary,
  curveY,
  decidedFactsForAction,
  dimensionScoreLabel,
  ENGAGEMENT_COPY,
  groupRecommendations,
  isEditAction,
  metricsLabel,
  overallLabel,
  PRIORITY_LABELS,
  potentialLabel,
  RECOMMENDATION_ACTION_HINTS,
  RECOMMENDATION_ACTION_LABELS,
  recommendationActions,
  recommendationRequest,
  scenesByIds,
  scoreLabel,
} from "../src/lib/engagement-ui.ts";
import { isReportOutOfDate } from "../src/lib/originality-ui.ts";
import { ENGAGEMENT_ACTION } from "../src/lib/quick-actions.ts";
import { REPORT_CONFIRM_COPY } from "../src/lib/report-confirm.ts";
import { createSession, parseSessions, planSignature, serializeSessions, type StorySession } from "../src/lib/session.ts";
import type { StoryContext } from "../src/lib/story-context.ts";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "../src/lib/story-input.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";
import { checkEngagement, withEngagementReport } from "../src/lib/studio-agent.ts";
import type { UsageRecord } from "../src/lib/usage.ts";

const NOW = 1_764_300_000_000;

const shot = (action: string) => ({
  seconds: 4,
  framing: "Wide",
  camera: "Still",
  characters: ["Mara"],
  location: "Pier",
  action,
  dialogue: [],
  emotion: "Tense",
  sound: "Wind",
});

const plan: ShotPlan = {
  title: "The Keeper",
  logline: "A lighthouse keeper finds a stranger.",
  intent: "Loneliness ends.",
  characters: [{ name: "Mara", role: "Keeper", look: "Grey coat", personality: "Quiet", voice: "Low" }],
  locations: [{ name: "Pier", description: "Old wooden pier" }],
  scenes: [
    { title: "Storm", shots: [shot("Waves hit the pier")] },
    { title: "Rescue", shots: [shot("Mara pulls a man from the water")] },
    { title: "Silence", shots: [shot("They eat without speaking")] },
    { title: "Leaving", shots: [shot("The boat leaves at dawn")] },
  ],
  reviewNotes: [],
};

const metrics = { seconds: 62, shots: 9, averageShotSeconds: 6.9, dialogueLines: 4, shotsWithDialogue: 3, characters: 2 };

function scene(sceneId: string, title: string, potential: number | null, overrides: Partial<SceneAssessment> = {}): SceneAssessment {
  return {
    sceneId,
    title,
    status: potential === null ? "failed" : "ok",
    summary: potential === null ? "" : `${title} happens.`,
    purpose: potential === null ? "" : "Sets up the conflict.",
    strengths: potential === null ? [] : ["Clear goal"],
    weaknesses: potential === null ? [] : ["Slow middle"],
    pacing: potential === null ? "" : "Steady.",
    curiosity: "",
    emotion: "",
    improvements: [],
    flags: potential === null ? [] : ["tension_drop"],
    evidence: potential === null ? [] : [`${sceneId}_SH01`],
    ratings: potential === null ? null : { tension: 3, curiosity: 3, emotion: 3, change: 1 },
    potential,
    metrics,
    ...overrides,
  };
}

const recommendation = (overrides: Partial<EngagementRecommendation> = {}): EngagementRecommendation => ({
  id: "r1",
  priority: "high",
  action: "pacing",
  sceneRefs: ["S02", "S03"],
  problem: "The middle slows down after the rescue.",
  whyItMatters: "Attention dips before the turn.",
  alternative: "Cut the meal short and end on the knock at the door.",
  benefit: "Keeps tension up into the ending.",
  ...overrides,
});

function serverReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    overall: { score: 72, summary: "A clear hook with a slower middle." },
    keyFactors: ["Strong opening image"],
    dimensions: ENGAGEMENT_DIMENSIONS.map((dimension, index) => ({
      dimension,
      score: index === 6 ? null : 60 + index,
      insufficient: index === 6,
      explanation: "Because of the storm.",
      evidence: ["S01"],
    })),
    scenes: [scene("S01", "Storm", 82), scene("S02", "Rescue", 64), scene("S03", "Silence", null), scene("S04", "Leaving", 41)],
    curveNotes: [
      { sceneId: "S02", note: "Calmer after the storm." },
      { sceneId: "S04", note: "Ending lands softly." },
      { sceneId: "S02", note: "The rescue resolves fast." },
    ],
    strongest: ["S01"],
    weakest: ["S04"],
    recommendations: [
      recommendation({ id: "r3", priority: "low", action: "discuss" }),
      recommendation(),
      recommendation({ id: "r2", priority: "medium", action: "alternative_scene" }),
    ],
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): EngagementReport {
  return { ...serverReport(overrides), createdAt: NOW, planSignature: planSignature(plan) } as EngagementReport;
}

const usage = (totalTokens: number): UsageRecord => ({
  step: "engagement",
  model: "test-model",
  inputTokens: totalTokens,
  outputTokens: 0,
  totalTokens,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown, status = 200): { calls: { url: string; body: Record<string, unknown> }[] } {
  const record: { calls: { url: string; body: Record<string, unknown> }[] } = { calls: [] };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    record.calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return record;
}

test("checkEngagement stamps createdAt and the analysed plan's signature, and keeps valid usage", async () => {
  const records = [usage(900), usage(300)];
  const context: StoryContext = { facts: [], unresolved: [] };
  const fetched = mockFetch({ report: serverReport(), usage: [...records, { step: "engagement" }] });
  const result = await checkEngagement({ title: "The Keeper", plan, context, source: "Story text" }, NOW);
  assert.ok(result.ok);
  assert.equal(result.report.createdAt, NOW);
  assert.equal(result.report.planSignature, planSignature(plan));
  assert.equal(result.report.scenes.length, 4);
  assert.deepEqual(result.usage, records);
  assert.equal(fetched.calls[0].url, "/api/story/engagement");
  assert.deepEqual(Object.keys(fetched.calls[0].body).sort(), ["context", "plan", "source", "title"]);
});

test("checkEngagement overrides any createdAt or signature the server sends", async () => {
  mockFetch({ report: serverReport({ createdAt: 1, planSignature: "forged" }), usage: [] });
  const result = await checkEngagement({ title: "The Keeper", plan }, NOW);
  assert.ok(result.ok);
  assert.equal(result.report.createdAt, NOW);
  assert.equal(result.report.planSignature, planSignature(plan));
});

test("checkEngagement sends only the title and plan when there is no context or usable source", async () => {
  const fetched = mockFetch({ report: serverReport(), usage: [] });
  await checkEngagement({ title: "  ", plan, source: "x".repeat(26_001) }, NOW);
  const body = fetched.calls[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["plan", "title"]);
  assert.equal(body.title, "Untitled project");
});

test("a malformed report or a server error becomes a readable error", async () => {
  mockFetch({ report: serverReport({ scenes: [{ sceneId: "S01" }] }), usage: [] });
  const malformed = await checkEngagement({ title: "T", plan }, NOW);
  assert.ok(!malformed.ok && /incomplete/.test(malformed.error));

  mockFetch({ report: serverReport({ dimensions: [] }), usage: [] });
  assert.equal((await checkEngagement({ title: "T", plan }, NOW)).ok, false);

  mockFetch({ report: [], usage: [] });
  assert.equal((await checkEngagement({ title: "T", plan }, NOW)).ok, false);

  mockFetch({ report: serverReport({ version: 2 }) });
  assert.equal((await checkEngagement({ title: "T", plan }, NOW)).ok, false);

  mockFetch({ error: "The analysis is busy. Try again in a minute." }, 503);
  assert.deepEqual(await checkEngagement({ title: "T", plan }, NOW), {
    ok: false,
    error: "The analysis is busy. Try again in a minute.",
  });
});

test("the report is stored on the session and survives a reload; a broken saved report is dropped", () => {
  const session: StorySession = { ...createSession("The Keeper"), phase: "refining", plan };
  const stored = withEngagementReport(session, report());
  assert.deepEqual(stored.engagement, { report: report() });
  assert.equal(session.engagement, undefined);
  const reloaded = parseSessions(JSON.stringify(serializeSessions([stored], stored.id))).sessions[0];
  assert.deepEqual(reloaded.engagement, stored.engagement);

  const broken = { ...stored, engagement: { report: { ...report(), version: 2 } } } as unknown as StorySession;
  const dropped = parseSessions(JSON.stringify(serializeSessions([broken], broken.id))).sessions[0];
  assert.equal(dropped.id, broken.id);
  assert.equal(dropped.engagement, undefined);
});

test("the report is out of date once the plan changes", () => {
  const analysed = report();
  assert.equal(isReportOutOfDate(plan, analysed), false);
  assert.equal(isReportOutOfDate({ ...plan, logline: "Changed" }, analysed), true);
  assert.equal(isReportOutOfDate(null, analysed), true);
});

test("curve: one point per scene in plan order, y from 0–100, failed scenes are gaps", () => {
  const geometry = curveGeometry(report());
  const { points, plot } = geometry;
  assert.deepEqual(
    points.map((point) => [point.sceneId, point.value, point.tone]),
    [
      ["S01", 82, "strongest"],
      ["S02", 64, "normal"],
      ["S03", null, "gap"],
      ["S04", 41, "weakest"],
    ],
  );
  for (let index = 1; index < points.length; index += 1) assert.ok(points[index].x > points[index - 1].x);
  assert.ok(points[0].x > plot.left && points.at(-1)!.x < plot.right);
  assert.equal(points[2].y, null);
  assert.equal(curveY(0), plot.bottom);
  assert.equal(curveY(100), plot.top);
  assert.equal(curveY(50), (plot.top + plot.bottom) / 2);
  assert.equal(curveY(140), plot.top);
  assert.equal(points[0].y, curveY(82));
  assert.ok((points[0].y ?? 0) < (points[1].y ?? 0));
  assert.deepEqual(geometry.segments, [`M${points[0].x} ${points[0].y} L${points[1].x} ${points[1].y}`]);
  assert.equal(points[1].labelY, null);
  assert.ok(points[0].labelY !== null && points[0].labelY < (points[0].y ?? 0));
  assert.ok(points[3].labelY !== null && points[3].labelY > (points[3].y ?? 0));
  assert.deepEqual(geometry.ticks.map((tick) => tick.value), [0, 25, 50, 75, 100]);
  assert.equal(geometry.width, CURVE_SIZE.width);
});

test("curve: notes become numbered markers per scene; labels thin out on long films; one scene sits centred", () => {
  const { markers } = curveGeometry(report());
  assert.deepEqual(
    markers.map((marker) => [marker.sceneId, marker.label]),
    [
      ["S02", "1,3"],
      ["S04", "2"],
    ],
  );
  assert.deepEqual(curveGeometry(report({ curveNotes: [{ sceneId: "S99", note: "Unknown" }] })).markers, []);

  const many = Array.from({ length: 20 }, (_, index) => scene(`S${String(index + 1).padStart(2, "0")}`, `Scene ${index}`, 50));
  const long = curveGeometry(report({ scenes: many, strongest: [], weakest: [], curveNotes: [] }));
  assert.equal(long.points.filter((point) => point.showLabel).length, 10);
  assert.equal(long.segments.length, 1);

  const single = curveGeometry(report({ scenes: [scene("S01", "Only", 70)], strongest: ["S01"], weakest: ["S01"], curveNotes: [] }));
  assert.equal(single.points[0].x, (single.plot.left + 12 + single.plot.right - 12) / 2);
  assert.equal(single.points[0].tone, "strongest");
  assert.deepEqual(single.segments, []);

  const failedFirst = curveGeometry(report({ scenes: [scene("S01", "A", null), scene("S02", "B", 60), scene("S03", "C", 70)] }));
  assert.equal(failedFirst.segments.length, 1);
  assert.ok(failedFirst.segments[0].startsWith(`M${failedFirst.points[1].x} `));
});

test("curve summary names the range, the highest and lowest scenes and the gaps", () => {
  const summary = curveSummary(curveGeometry(report()).points);
  assert.match(summary, /4 scenes/);
  assert.match(summary, /Highest: S01 at 82/);
  assert.match(summary, /Lowest: S04 at 41/);
  assert.match(summary, /1 scene couldn’t be analysed/);
});

test("scores show the number and band in words, or say there isn't enough evidence", () => {
  assert.equal(scoreLabel(72), "72 · Solid");
  assert.equal(scoreLabel(85), "85 · Strong");
  assert.equal(scoreLabel(12), "12 · Very weak");
  assert.equal(overallLabel(72), "72 · Solid");
  assert.equal(overallLabel(null), "Not enough evidence for an overall score");
  assert.equal(dimensionScoreLabel({ score: 64, insufficient: false }), "64 · Mixed");
  assert.equal(dimensionScoreLabel({ score: null, insufficient: true }), "Not enough evidence");
  assert.equal(dimensionScoreLabel({ score: 40, insufficient: true }), "Not enough evidence");
  assert.equal(potentialLabel(scene("S01", "A", 88)), "88 · Strong");
  assert.equal(potentialLabel(scene("S01", "A", null)), "Not analysed");
  assert.equal(potentialLabel(scene("S01", "A", 82, { status: "failed" })), "Not analysed");
  assert.equal(bandTone(90), "strong");
  assert.equal(bandTone(10), "very-weak");
  assert.equal(bandTone(null), "none");
  assert.equal(metricsLabel(metrics), "62 s · 9 shots · 4 lines of dialogue");
  assert.equal(metricsLabel({ seconds: 4.4, shots: 1, dialogueLines: 1 }), "4 s · 1 shot · 1 line of dialogue");
  assert.equal(metricsLabel({ seconds: 0, shots: 0, dialogueLines: 0 }), "0 s · 0 shots · no dialogue");
  assert.equal(analysedAtLabel("28 Nov 2026"), "Analysed 28 Nov 2026");
});

test("strongest and weakest lists follow the report order and skip unknown scenes", () => {
  const { scenes } = report();
  assert.deepEqual(
    scenesByIds(scenes, ["S04", "S99", "S01", "S04"]).map((item) => item.sceneId),
    ["S04", "S01"],
  );
});

test("recommendations are grouped High, Medium, Low and every one can be discussed", () => {
  const groups = groupRecommendations(report().recommendations);
  assert.deepEqual(
    groups.map((group) => [group.priority, group.recommendations.map((item) => item.id)]),
    [
      ["high", ["r1"]],
      ["medium", ["r2"]],
      ["low", ["r3"]],
    ],
  );
  assert.deepEqual(PRIORITY_LABELS, { high: "High", medium: "Medium", low: "Low" });
  assert.deepEqual(recommendationActions({ action: "discuss" }), ["discuss"]);
  assert.deepEqual(recommendationActions({ action: "suspense" }), ["discuss", "suspense"]);
  assert.deepEqual(
    RECOMMENDATION_ACTIONS.filter((action) => !isEditAction(action)),
    ["discuss", "alternative_scene"],
  );
  assert.equal(RECOMMENDATION_ACTION_LABELS.discuss, "Discuss with Creative Director");
  assert.equal(RECOMMENDATION_ACTION_LABELS.alternative_scene, "Suggest alternative scene");
  assert.equal(RECOMMENDATION_ACTION_LABELS.opening_hook, "Strengthen opening hook");
});

const titles = report().scenes;

test("Discuss and Suggest alternative scene name the scenes, problem and suggestion, and keep the board as it is", () => {
  for (const action of ["discuss", "alternative_scene"] as const) {
    const request = recommendationRequest(action, recommendation(), titles);
    assert.equal(request.intent, undefined, action);
    for (const part of ["S02 “Rescue”", "S03 “Silence”", recommendation().problem, recommendation().alternative]) {
      assert.ok(request.message.includes(part), `${action}: ${part}`);
    }
    assert.ok(request.message.endsWith("Don’t change the board yet."), action);
  }
  assert.ok(recommendationRequest("discuss", recommendation(), titles).message.includes(recommendation().benefit));
  assert.ok(recommendationRequest("alternative_scene", recommendation(), titles).message.includes("2–3"));
});

test("reply-only messages reach the story expert, even when the problem mentions removing a scene", () => {
  const structural = recommendation({ problem: "Remove the scene where they eat.", alternative: "Add a scene at the pier." });
  for (const action of ["discuss", "alternative_scene"] as const) {
    assert.ok(selectSpecialists(recommendationRequest(action, structural).message).includes("story-analyst"), action);
  }
});

test("revision actions ask for a change to only the named scenes, sent as an edit", () => {
  const edits = RECOMMENDATION_ACTIONS.filter(isEditAction);
  assert.deepEqual(edits, ["pacing", "opening_hook", "character_investment", "suspense", "emotional_payoff"]);
  for (const action of edits) {
    const request = recommendationRequest(action, recommendation({ action }), titles);
    assert.equal(request.intent, "edit", action);
    assert.ok(request.message.startsWith("Revise only these scenes: S02 “Rescue”, S03 “Silence”."), action);
    assert.ok(request.message.includes(recommendation().problem), action);
    assert.ok(request.message.includes(recommendation().alternative), action);
    assert.ok(request.message.endsWith("Keep everything else as it is."), action);
    assert.ok(!request.message.includes("Don’t change the board"), action);
  }
  assert.ok(
    recommendationRequest("pacing", recommendation({ sceneRefs: ["S02", "S02_SH03"] })).message.startsWith(
      "Revise only these parts: S02, S02_SH03.",
    ),
  );
  assert.ok(recommendationRequest("pacing", recommendation({ sceneRefs: [] })).message.startsWith("Revise only the scenes"));
});

test("every action message fits in one chat message and keeps its closing line", () => {
  const longest = recommendation({
    sceneRefs: Array.from({ length: 12 }, (_, index) => `S${index + 10}`),
    problem: "p".repeat(400),
    whyItMatters: "w".repeat(400),
    alternative: "a".repeat(600),
    benefit: "b".repeat(300),
  });
  const longTitles = Array.from({ length: 12 }, (_, index) => scene(`S${index + 10}`, "t".repeat(200), 50));
  for (const action of RECOMMENDATION_ACTIONS) {
    const { message } = recommendationRequest(action, longest, longTitles);
    assert.ok(message.length <= MAX_CHAT_MESSAGE_CHARACTERS, action);
    assert.ok(message.endsWith(isEditAction(action) ? "Keep everything else as it is." : "Don’t change the board yet."), action);
  }
});

test("revisions confirm first only about decided facts in the categories they may touch", () => {
  assert.deepEqual(ACTION_FACT_CATEGORIES, {
    opening_hook: ["concept", "structure"],
    character_investment: ["characters", "relationships"],
    suspense: ["structure", "scenes"],
    pacing: ["structure", "scenes"],
    emotional_payoff: ["intent", "structure"],
  });
  const context: StoryContext = {
    unresolved: [],
    facts: [
      { category: "concept", label: "Idea", value: "Keeper finds stranger", source: "user", approved: true },
      { category: "structure", label: "Ending", value: "They leave together", source: "ai", approved: true },
      { category: "structure", label: "Middle", value: "A storm", source: "ai", approved: false },
      { category: "characters", label: "Main character", value: "Mara", source: "user", approved: true },
      { category: "relationships", label: "Bond", value: "Strangers", source: "user", approved: true },
      { category: "scenes", label: "Scene count", value: "Four", source: "ai", approved: true },
      { category: "intent", label: "Feeling", value: "Hope", source: "user", approved: true },
    ],
  };
  const labels = (action: RecommendationAction) => decidedFactsForAction(context, action).map((fact) => fact.label);
  assert.deepEqual(labels("opening_hook"), ["Idea", "Ending"]);
  assert.deepEqual(labels("character_investment"), ["Main character", "Bond"]);
  assert.deepEqual(labels("suspense"), ["Ending", "Scene count"]);
  assert.deepEqual(labels("pacing"), ["Ending", "Scene count"]);
  assert.deepEqual(labels("emotional_payoff"), ["Ending", "Feeling"]);
  assert.deepEqual(labels("discuss"), []);
  assert.deepEqual(labels("alternative_scene"), []);
  assert.deepEqual(decidedFactsForAction(undefined, "pacing"), []);
});

test("no UI copy shows viewer percentages, drop-off, retention rates or box-office wording", () => {
  const { panelTitle, ...rest } = ENGAGEMENT_COPY;
  assert.equal(panelTitle, ENGAGEMENT_ENTRY_LABEL);
  assert.equal(ENGAGEMENT_ACTION.label, ENGAGEMENT_ENTRY_LABEL);
  const copy = [
    ...Object.values(rest),
    ENGAGEMENT_ACTION.shortLabel,
    REPORT_CONFIRM_COPY.engagement.title,
    REPORT_CONFIRM_COPY.engagement.text,
    ...Object.values(RECOMMENDATION_ACTION_LABELS),
    ...Object.values(RECOMMENDATION_ACTION_HINTS),
    ...Object.values(PRIORITY_LABELS),
    ENGAGEMENT_ACTION.tooltip,
    analysedAtLabel("28 Nov 2026"),
    overallLabel(72),
    overallLabel(null),
    metricsLabel(metrics),
    curveSummary(curveGeometry(report()).points),
    ...RECOMMENDATION_ACTIONS.map((action) => recommendationRequest(action, recommendation({ action }), titles).message),
  ];
  for (const text of copy) {
    assert.doesNotMatch(
      text,
      /%|percent|drop[- ]?off|retention|box[- ]?office|of (?:the )?viewers|viewers (?:will|would|who)|will (?:stop )?watch|tickets?|revenue|predict/i,
      text,
    );
  }
});
