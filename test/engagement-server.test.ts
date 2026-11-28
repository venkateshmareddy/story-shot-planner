import assert from "node:assert/strict";
import { test } from "node:test";
import { maxDuration, POST } from "../src/app/api/story/engagement/route.ts";
import {
  bandFor,
  DIMENSION_WEIGHTS,
  ENGAGEMENT_DIMENSIONS,
  type EngagementDimension,
  engagementReportSchema,
  MAX_ENGAGEMENT_SCENES,
  MAX_RECOMMENDATIONS,
  overallScore,
  RECOMMENDATION_ACTIONS,
  SCENE_FLAGS,
  type SceneAssessment,
  scenePotential,
} from "../src/lib/engagement.ts";
import { SECTION } from "../src/lib/server/memory-view.ts";
import { type CallModel, type ModelCall, ModelOutputError, type PrewarmCall } from "../src/lib/server/openai.ts";
import {
  ENGAGEMENT_FAILED_MESSAGE,
  EngagementError,
  type EngagementSceneOutput,
  type EngagementSummaryOutput,
  highlightScenes,
  MAX_CURVE_NOTES,
  NO_SCENES_MESSAGE,
  paceMetrics,
  QUIET_SCENE_TEXT,
  REMOVAL_REASONS,
  removalTargets,
  runEngagement,
  SCENE_ASSESSMENT_MAX_OUTPUT_TOKENS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  TOO_MANY_SCENES_MESSAGE,
  withoutRetentionClaims,
} from "../src/lib/server/engagement.ts";
import { composeInstructions } from "../src/lib/server/prompts.ts";
import type { StoryContext } from "../src/lib/story-context.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord } from "../src/lib/usage.ts";
import { memoryFacts, sectionText, sectionTitles } from "./model-input.ts";

type Shot = ShotPlan["scenes"][number]["shots"][number];
type Recommendation = EngagementSummaryOutput["recommendations"][number];

const shot = (action: string, seconds = 4, dialogue: Shot["dialogue"] = [], characters = ["Mara"]): Shot => ({
  seconds,
  framing: "Wide",
  camera: "Static",
  characters,
  location: "Lighthouse",
  action,
  dialogue,
  emotion: "Dread",
  sound: "Wind",
});

const PLAN: ShotPlan = {
  title: "The Last Keeper",
  logline: "A lonely keeper relights a dying lighthouse.",
  intent: "Loneliness turning to resolve.",
  characters: [
    { name: "Mara", role: "Keeper", look: "Oilskin coat", personality: "Stubborn", voice: "Low" },
    { name: "Wil", role: "Stranded sailor", look: "Torn jacket", personality: "Chatty", voice: "Hoarse" },
  ],
  locations: [{ name: "Lighthouse", description: "Storm-battered tower" }],
  scenes: [
    { title: "Storm night", shots: [shot("Mara climbs the spiral stairs as the storm hits."), shot("The lamp flickers and dies.", 5)] },
    {
      title: "The wreck",
      shots: [
        shot("Mara drags a sailor from the surf.", 6, [{ speaker: "Mara", line: "You’re safe now.", delivery: "Breathless" }]),
        shot("Wil coughs up seawater.", 4, [
          { speaker: "Wil", line: "Where am I?", delivery: "Hoarse" },
          { speaker: "Mara", line: " ", delivery: "" },
        ], ["Mara", "Wil"]),
      ],
    },
    { title: "Quiet watch", shots: [shot("Mara sits by the cold lamp, saying nothing.", 20), shot("Rain runs down the glass.", 25, [], [])] },
    { title: "Dawn", shots: [shot("Mara relights the lamp as the sun rises.")] },
  ],
  reviewNotes: [],
};

const CONTEXT: StoryContext = {
  facts: [
    { category: "characters", label: "Main character", value: "Mara, the keeper", source: "user", approved: true },
    { category: "locations", label: "Main place", value: "A lighthouse", source: "ai", approved: true },
    { category: "genre", label: "Genre", value: "UNAPPROVED HORROR GUESS", source: "ai", approved: false },
  ],
  unresolved: [],
};

const request = (plan: ShotPlan = PLAN) => ({ title: "The Last Keeper", plan, context: CONTEXT, source: "SOURCE STORY TEXT" });

const usage = (inputTokens: number): UsageRecord => ({
  step: "engagement",
  model: "gpt-test",
  inputTokens,
  outputTokens: 50,
  totalTokens: inputTokens + 50,
});

const sceneOutput = (overrides: Partial<EngagementSceneOutput> = {}): EngagementSceneOutput => ({
  summary: "Mara climbs the tower.",
  purpose: "Sets up the failing light.",
  strengths: ["A clear problem in the first shot."],
  weaknesses: [],
  pacing: "Short shots keep it moving.",
  curiosity: "Why does the lamp fail?",
  emotion: "Dread that grows.",
  improvements: [],
  flags: [],
  evidence: [],
  ratings: { tension: 3, curiosity: 3, emotion: 3, change: 1 },
  ...overrides,
});

const dimensions = (scores: Partial<Record<EngagementDimension, number | null>> = {}) =>
  ENGAGEMENT_DIMENSIONS.map((dimension) => {
    const score = dimension in scores ? (scores[dimension] ?? null) : 70;
    return { dimension, score, insufficient: score === null, explanation: `About ${dimension} in S01.`, evidence: ["S01"] };
  });

const recommendation = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  priority: "medium",
  action: "suspense",
  sceneRefs: ["S02"],
  problem: "The wreck reveals the sailor too early.",
  whyItMatters: "The question of who he is closes before it can pull us forward.",
  alternative: "Keep his face hidden until the end of S02.",
  benefit: "The question stays open into the next scene.",
  ...overrides,
});

const summaryOutput = (overrides: Partial<EngagementSummaryOutput> = {}): EngagementSummaryOutput => ({
  summary: "The film opens on a clear problem and builds to a quiet win.",
  keyFactors: ["A clear question in the first shot."],
  dimensions: dimensions(),
  curveNotes: [],
  recommendations: [],
  ...overrides,
});

const fullInput = (call: ModelCall) => `${call.cachedPrefix ?? ""}${call.input}`;

function sceneNumber(call: ModelCall): number | undefined {
  const own = sectionText(call.input, SECTION.sceneToAssess);
  return own ? Number(/^S(\d+)/.exec(own)?.[1]) : undefined;
}

type FakeOptions = {
  scene?: (scene: number, call: ModelCall) => unknown | Promise<unknown>;
  summary?: unknown | (() => unknown);
  delay?: (scene: number) => number;
  prewarm?: (call: PrewarmCall) => Promise<UsageRecord>;
};

function fakeModel(options: FakeOptions = {}) {
  const calls: ModelCall[] = [];
  const prewarms: PrewarmCall[] = [];
  const events: string[] = [];
  const callModel: CallModel = async (call) => {
    calls.push(call);
    const scene = sceneNumber(call);
    if (scene === undefined) {
      events.push("summary");
      const output = await (typeof options.summary === "function" ? (options.summary as () => unknown)() : (options.summary ?? summaryOutput()));
      return { output, usage: usage(900) };
    }
    events.push(`scene ${scene}`);
    await new Promise((resolve) => setTimeout(resolve, options.delay?.(scene) ?? 2));
    const output = options.scene ? await options.scene(scene, call) : sceneOutput();
    return { output, usage: usage(100 + scene) };
  };
  if (options.prewarm) {
    const { prewarm } = options;
    callModel.prewarm = (call) => {
      prewarms.push(call);
      events.push("prewarm");
      return prewarm(call);
    };
  }
  return {
    callModel,
    calls,
    prewarms,
    events,
    sceneCalls: () => calls.filter((call) => sceneNumber(call) !== undefined),
    summaryCall: () => calls.find((call) => sceneNumber(call) === undefined),
  };
}

const quiet = (t: { mock: { method: (object: Console, name: "info" | "warn", fn: () => void) => unknown } }) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
};

const withRatings = (ratings: EngagementSceneOutput["ratings"]) => sceneOutput({ ratings });

// --- Pace metrics and inputs ---

test("pace metrics are measured in code per scene: seconds, shots, average, dialogue and distinct characters", () => {
  assert.deepEqual(paceMetrics(PLAN.scenes[1]), {
    seconds: 10,
    shots: 2,
    averageShotSeconds: 5,
    dialogueLines: 2,
    shotsWithDialogue: 2,
    characters: 2,
  });
  assert.deepEqual(paceMetrics(PLAN.scenes[2]), {
    seconds: 45,
    shots: 2,
    averageShotSeconds: 22.5,
    dialogueLines: 0,
    shotsWithDialogue: 0,
    characters: 1,
  });
  assert.deepEqual(paceMetrics({ title: "Empty", shots: [] }), {
    seconds: 0,
    shots: 0,
    averageShotSeconds: 0,
    dialogueLines: 0,
    shotsWithDialogue: 0,
    characters: 0,
  });
  assert.equal(paceMetrics({ title: "Bad", shots: [shot("x", -3), shot("y", 2.25)] }).seconds, 2.3);
});

test("scene calls share one prefix (film, confirmed memory, source, every scene with metrics) and get their own shot list", async (t) => {
  quiet(t);
  const fake = fakeModel();
  await runEngagement(request(), fake.callModel);
  const scenes = fake.sceneCalls();
  assert.equal(scenes.length, 4);
  const [first] = scenes;
  const input = fullInput(first);
  assert.deepEqual(sectionTitles(input), [SECTION.film, SECTION.memory, SECTION.source, SECTION.scenes, SECTION.sceneToAssess]);
  assert.match(sectionText(input, SECTION.film) ?? "", /Characters:\n- Mara — Keeper — Stubborn\n- Wil — Stranded sailor — Chatty/);
  assert.deepEqual(
    memoryFacts(input).map(({ value, status }) => [value, status]),
    [
      ["Mara, the keeper", "filmmaker"],
      ["A lighthouse", "approved"],
    ],
  );
  assert.ok(!input.includes("UNAPPROVED HORROR GUESS"), "unapproved AI suggestions aren't the story");
  assert.equal(sectionText(input, SECTION.source), "SOURCE STORY TEXT");
  const outline = (sectionText(input, SECTION.scenes) ?? "").split("\n");
  assert.equal(outline.length, 4);
  assert.match(outline[2], /^S03 · Quiet watch — 45 s, 2 shots \(about 22\.5 s each\), 0 dialogue lines in 0 shots, 1 character/);
  assert.match(outline[1], /Opens: Mara drags a sailor from the surf\. · Ends: Wil coughs up seawater\./);
  assert.equal(
    sectionText(scenes[1].input, SECTION.sceneToAssess),
    [
      "S02 · The wreck — 10 s, 2 shots (about 5 s each), 2 dialogue lines in 2 shots, 2 characters",
      "- S02_SH01 · 6 s · Mara drags a sailor from the surf. · Emotion: Dread · Sound: Wind",
      "  Mara: You’re safe now.",
      "- S02_SH02 · 4 s · Wil coughs up seawater. · Emotion: Dread · Sound: Wind",
      "  Wil: Where am I?",
    ].join("\n"),
  );
  for (const call of scenes) {
    assert.equal(call.step, "engagement");
    assert.equal(call.stage, "engagement_scene");
    assert.equal(call.maxOutputTokens, SCENE_ASSESSMENT_MAX_OUTPUT_TOKENS);
    assert.equal(call.instructions, composeInstructions("engagement_scene", "short_film"));
    assert.equal(fullInput(call).split(`## ${SECTION.sceneToAssess}`)[0], fullInput(first).split(`## ${SECTION.sceneToAssess}`)[0]);
  }
});

test("the summary gets the scene results and metrics, not the plan or the source again", async (t) => {
  quiet(t);
  const fake = fakeModel({
    scene: (scene) =>
      scene === 3 ? new Promise((_, reject) => reject(new Error("down"))) : sceneOutput({ flags: ["tension_drop"], evidence: [`S0${scene}_SH01`] }),
  });
  await runEngagement(request(), fake.callModel);
  const summary = fake.summaryCall();
  assert.ok(summary);
  assert.equal(summary.stage, "engagement_summary");
  assert.equal(summary.maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS);
  assert.equal(summary.cachedPrefix, undefined);
  assert.deepEqual(sectionTitles(summary.input), [SECTION.film, SECTION.memory, SECTION.sceneAssessments]);
  const results = sectionText(summary.input, SECTION.sceneAssessments) ?? "";
  assert.ok(!summary.input.includes("SOURCE STORY TEXT") && !summary.input.includes("Mara drags a sailor"));
  assert.match(results, /^S01 · Storm night — 9 s, 2 shots/);
  assert.match(results, /Flags: tension_drop\nEvidence: S01_SH01\nRatings: tension 3, curiosity 3, emotion 3, change 1; potential 58/);
  assert.match(results, /S03 · Quiet watch — 45 s, .* — not assessed \(this scene couldn’t be analysed\)/);
});

// --- Dimensions and the overall score ---

test("a strong versus a weak opening hook flows from the scene ratings into the summary and the dimension output", async (t) => {
  quiet(t);
  const run = async (strong: boolean) => {
    const fake = fakeModel({
      scene: (scene) =>
        scene === 1
          ? withRatings(strong ? { tension: 4, curiosity: 5, emotion: 3, change: 2 } : { tension: 1, curiosity: 1, emotion: 2, change: 0 })
          : sceneOutput(),
      summary: summaryOutput({
        dimensions: dimensions({ opening_hook: strong ? 90 : 25 }).map((entry) =>
          entry.dimension === "opening_hook"
            ? { ...entry, explanation: strong ? "S01_SH01 raises a clear question at once." : "S01 spends its shots on setup.", evidence: ["S01_SH01"] }
            : entry,
        ),
      }),
    });
    const { report } = await runEngagement(request(), fake.callModel);
    return { report, summaryInput: fake.summaryCall()?.input ?? "" };
  };
  const strong = await run(true);
  const weak = await run(false);
  const hook = (report: typeof strong.report) => report.dimensions.find(({ dimension }) => dimension === "opening_hook");
  assert.deepEqual(hook(strong.report), {
    dimension: "opening_hook",
    score: 90,
    insufficient: false,
    explanation: "S01_SH01 raises a clear question at once.",
    evidence: ["S01_SH01"],
  });
  assert.equal(hook(weak.report)?.score, 25);
  assert.equal(bandFor(90), "Strong");
  assert.equal(bandFor(25), "Very weak");
  assert.equal(strong.report.scenes[0].potential, scenePotential({ tension: 4, curiosity: 5, emotion: 3, change: 2 }));
  assert.equal(weak.report.scenes[0].potential, 21);
  assert.match(strong.summaryInput, /Ratings: tension 4, curiosity 5, emotion 3, change 2; potential 84/);
  assert.ok((strong.report.overall.score ?? 0) > (weak.report.overall.score ?? 100));
});

test("character engagement, strong suspense and emotional progression come through in rubric order with real evidence", async (t) => {
  quiet(t);
  const raw = [
    { dimension: "suspense_curiosity" as const, score: 88, insufficient: false, explanation: "S02 keeps us asking who Wil is.", evidence: ["S2", "S02_SH2"] },
    { dimension: "character_engagement" as const, score: 74.6, insufficient: false, explanation: "Mara chooses to save Wil.", evidence: ["S02_SH01", "S09", "S02_SH07"] },
    { dimension: "character_engagement" as const, score: 10, insufficient: false, explanation: "Duplicate.", evidence: ["S01"] },
    { dimension: "emotional_engagement" as const, score: 120, insufficient: false, explanation: "Loneliness turns to resolve by S04.", evidence: ["s04", "Scene 3"] },
  ];
  const fake = fakeModel({
    scene: (scene) => withRatings({ tension: 2, curiosity: 2, emotion: [2, 3, 4, 5][scene - 1], change: 1 }),
    summary: summaryOutput({ dimensions: raw }),
  });
  const { report } = await runEngagement(request(), fake.callModel);
  assert.deepEqual(
    report.dimensions.map(({ dimension }) => dimension),
    [...ENGAGEMENT_DIMENSIONS],
  );
  const byId = Object.fromEntries(report.dimensions.map((entry) => [entry.dimension, entry]));
  assert.deepEqual(byId.character_engagement, {
    dimension: "character_engagement",
    score: 75,
    insufficient: false,
    explanation: "Mara chooses to save Wil.",
    evidence: ["S02_SH01"],
  });
  assert.deepEqual(byId.suspense_curiosity.evidence, ["S02", "S02_SH02"]);
  assert.equal(bandFor(byId.suspense_curiosity.score ?? 0), "Strong");
  assert.equal(byId.emotional_engagement.score, 100, "clamped to the scale");
  assert.deepEqual(byId.emotional_engagement.evidence, ["S04", "S03"]);
  const potentials = report.scenes.map(({ potential }) => potential ?? 0);
  assert.ok(potentials.every((value, index) => index === 0 || value > potentials[index - 1]), "emotion rising scene by scene lifts the curve");
  assert.deepEqual(
    report.dimensions.filter(({ score }) => score === null).map(({ dimension, explanation }) => [dimension, explanation]),
    [
      ["opening_hook", "This wasn’t assessed this time."],
      ["pacing", "This wasn’t assessed this time."],
      ["scene_effectiveness", "This wasn’t assessed this time."],
      ["climax_resolution", "This wasn’t assessed this time."],
    ],
  );
});

test("no ending yet: climax and resolution is insufficient, and null and insufficient always agree", async (t) => {
  quiet(t);
  const fake = fakeModel({
    summary: summaryOutput({
      dimensions: dimensions({ climax_resolution: null }).map((entry) => {
        if (entry.dimension === "climax_resolution") return { ...entry, insufficient: false, explanation: "The story has no ending yet." };
        if (entry.dimension === "pacing") return { ...entry, score: 64, insufficient: true };
        if (entry.dimension === "emotional_engagement") return { ...entry, score: 80, evidence: ["S07", "nonsense"] };
        return entry;
      }),
    }),
  });
  const { report } = await runEngagement(request(), fake.callModel);
  const byId = Object.fromEntries(report.dimensions.map((entry) => [entry.dimension, entry]));
  assert.deepEqual([byId.climax_resolution.score, byId.climax_resolution.insufficient], [null, true]);
  assert.equal(byId.climax_resolution.explanation, "The story has no ending yet.");
  assert.deepEqual([byId.pacing.score, byId.pacing.insufficient], [null, true], "insufficient wins over a score");
  assert.deepEqual([byId.emotional_engagement.score, byId.emotional_engagement.insufficient], [null, true], "a score without real evidence is a guess");
  for (const entry of report.dimensions) assert.equal(entry.score === null, entry.insufficient, entry.dimension);
});

test("the overall score is the weighted mean worked out in code; any overall the model sends is ignored", async (t) => {
  quiet(t);
  const scores = { opening_hook: 90, character_engagement: 60, pacing: 40, suspense_curiosity: 80, emotional_engagement: 70, scene_effectiveness: 50, climax_resolution: 32 };
  const fake = fakeModel({ summary: { ...summaryOutput({ dimensions: dimensions(scores) }), overall: { score: 99 }, overallScore: 99, score: 99 } });
  const { report } = await runEngagement(request(), fake.callModel);
  const expected = Object.entries(scores).reduce((sum, [dimension, score]) => sum + DIMENSION_WEIGHTS[dimension as EngagementDimension] * score, 0);
  assert.equal(report.overall.score, Math.round(expected));
  assert.equal(report.overall.score, 61);
  assert.equal(report.overall.score, overallScore(scores));
  assert.ok(!("overallScore" in report) && !("score" in report));
});

test("fewer than four scored dimensions: no overall score", async (t) => {
  quiet(t);
  const fake = fakeModel({
    summary: summaryOutput({
      dimensions: dimensions({ opening_hook: 80, character_engagement: 70, pacing: 60, suspense_curiosity: null, emotional_engagement: null, scene_effectiveness: null, climax_resolution: null }),
    }),
  });
  const { report } = await runEngagement(request(), fake.callModel);
  assert.equal(report.dimensions.filter(({ score }) => score !== null).length, 3);
  assert.equal(report.overall.score, null);
  assert.equal(report.overall.summary, "The film opens on a clear problem and builds to a quiet win.");
});

// --- Scenes and the curve ---

test("the curve has one point per scene in plan order, whatever order the calls finish in; a failed scene is a null point", async (t) => {
  quiet(t);
  const fake = fakeModel({
    delay: (scene) => (5 - scene) * 10,
    scene: (scene) => {
      if (scene === 2) throw new Error("network down");
      return withRatings({ tension: scene, curiosity: scene, emotion: scene, change: scene === 4 ? 2 : 1 });
    },
  });
  const { report } = await runEngagement(request(), fake.callModel);
  assert.deepEqual(
    fake.events.filter((event) => event.startsWith("scene")),
    ["scene 1", "scene 2", "scene 3", "scene 4"],
    "all four calls start at once",
  );
  assert.deepEqual(
    report.scenes.map(({ sceneId, title, status }) => [sceneId, title, status]),
    [
      ["S01", "Storm night", "ok"],
      ["S02", "The wreck", "failed"],
      ["S03", "Quiet watch", "ok"],
      ["S04", "Dawn", "ok"],
    ],
  );
  assert.deepEqual(report.scenes.map(({ potential }) => potential), [26, null, 58, 84]);
  const failed = report.scenes[1];
  assert.deepEqual(
    { ...failed, metrics: undefined },
    {
      sceneId: "S02",
      title: "The wreck",
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
      metrics: undefined,
    },
  );
  assert.equal(failed.metrics.seconds, 10, "metrics are still filled");
  assert.deepEqual(report.strongest, ["S04"]);
  assert.deepEqual(report.weakest, ["S01"]);
});

test("a repetitive scene keeps its flag once; slow pacing shows in the metrics and the flags", async (t) => {
  quiet(t);
  const fake = fakeModel({
    scene: (scene) =>
      scene === 3
        ? sceneOutput({
            flags: ["repetitive", "tension_drop", "repetitive", "no_story_change"],
            weaknesses: ["Repeats S01.", "Repeats S01.", "Long shots.", "Nothing changes.", "Too slow."],
            pacing: "Two shots of 20 and 25 seconds with no dialogue: nothing develops.",
            ratings: { tension: 1.4, curiosity: 0, emotion: 2, change: 3 },
          })
        : sceneOutput(),
  });
  const { report } = await runEngagement(request(), fake.callModel);
  const slow = report.scenes[2];
  assert.deepEqual(slow.flags, ["repetitive", "tension_drop", "no_story_change"]);
  assert.deepEqual(slow.weaknesses, ["Repeats S01.", "Long shots.", "Nothing changes."]);
  assert.deepEqual(slow.ratings, { tension: 1, curiosity: 1, emotion: 2, change: 2 }, "ratings clamped to the rubric's scale");
  assert.equal(slow.metrics.averageShotSeconds, 22.5);
  assert.equal(slow.metrics.dialogueLines, 0);
  assert.match(slow.pacing, /nothing develops/);
});

test("evidence keeps only real ids, normalised: scene evidence only from its own shots", async (t) => {
  quiet(t);
  const fake = fakeModel({
    scene: (scene) => sceneOutput({ evidence: scene === 2 ? ["S02_SH1", "s2-sh2", "S02_SH09", "S01_SH01", "S02", "Shot 2", "S02 SH02"] : [] }),
    summary: summaryOutput({
      curveNotes: [
        { sceneId: "S3", note: "The quiet watch lets the loss land." },
        { sceneId: "S09", note: "Not a scene." },
        { sceneId: "S03", note: "Duplicate note." },
        { sceneId: "S04_SH01", note: "The lamp comes back on." },
        { sceneId: "S02", note: "" },
      ],
      recommendations: [recommendation({ sceneRefs: ["S2", "S02_SH2", "S11", "S02_SH5", "intro"] })],
    }),
  });
  const { report } = await runEngagement(request(), fake.callModel);
  assert.deepEqual(report.scenes[1].evidence, ["S02_SH01", "S02_SH02"]);
  assert.deepEqual(report.curveNotes, [
    { sceneId: "S03", note: "The quiet watch lets the loss land." },
    { sceneId: "S04", note: "The lamp comes back on." },
  ]);
  assert.deepEqual(report.recommendations[0].sceneRefs, ["S02", "S02_SH02"]);
});

test("strongest and weakest: by potential, ties in plan order, failed scenes left out, never overlapping", () => {
  const scene = (sceneId: string, potential: number | null) => ({ sceneId, potential }) as SceneAssessment;
  assert.deepEqual(
    highlightScenes([scene("S01", 50), scene("S02", 80), scene("S03", 50), scene("S04", null), scene("S05", 80), scene("S06", 20), scene("S07", 50)]),
    { strongest: ["S02", "S05", "S01"], weakest: ["S06", "S03", "S07"] },
  );
  assert.deepEqual(highlightScenes([scene("S01", 50), scene("S02", null)]), { strongest: [], weakest: [] });
  assert.deepEqual(highlightScenes([scene("S01", 40), scene("S02", 60)]), { strongest: ["S02"], weakest: ["S01"] });
  assert.deepEqual(highlightScenes([scene("S01", 60), scene("S02", 60), scene("S03", 60), scene("S04", 60)]), {
    strongest: ["S01", "S02"],
    weakest: ["S03", "S04"],
  });
});

// --- Recommendations ---

test("recommendations: real refs, high to low, ids R01…, at most MAX_RECOMMENDATIONS, incomplete ones dropped", async (t) => {
  quiet(t);
  const many = [
    recommendation({ priority: "low", problem: "Low one." }),
    recommendation({ priority: "high", problem: "High one." }),
    recommendation({ priority: "medium", problem: "Medium one." }),
    recommendation({ priority: "high", problem: "Second high." }),
    recommendation({ priority: "high", problem: "", alternative: "Missing a problem." }),
    ...Array.from({ length: 8 }, (_, index) => recommendation({ priority: "medium", problem: `Filler ${index + 1}.` })),
  ];
  const fake = fakeModel({ summary: summaryOutput({ recommendations: many }) });
  const { report } = await runEngagement(request(), fake.callModel);
  assert.equal(report.recommendations.length, MAX_RECOMMENDATIONS);
  assert.deepEqual(
    report.recommendations.slice(0, 4).map(({ id, priority, problem }) => [id, priority, problem]),
    [
      ["R01", "high", "High one."],
      ["R02", "high", "Second high."],
      ["R03", "medium", "Medium one."],
      ["R04", "medium", "Filler 1."],
    ],
  );
  assert.ok(!report.recommendations.some(({ problem }) => problem === "Low one."), "the lowest priority is cut first");
  assert.ok(RECOMMENDATION_ACTIONS.includes(report.recommendations[0].action));
});

const QUIET_REMOVAL = recommendation({
  priority: "high",
  action: "pacing",
  sceneRefs: ["S03"],
  problem: "S03 is slow and low in tension.",
  whyItMatters: "Removing it would tighten the middle.",
  alternative: "Cut S03 and go straight from the wreck to dawn.",
  benefit: "A tighter film.",
});

test("quiet-scene guard: removing a scene that is only quiet becomes a keep-and-sharpen suggestion", async (t) => {
  quiet(t);
  const run = async (flags: EngagementSceneOutput["flags"], recommendations: Recommendation[]) => {
    const fake = fakeModel({
      scene: (scene) => (scene === 3 ? sceneOutput({ flags, ratings: { tension: 1, curiosity: 2, emotion: 4, change: 1 } }) : sceneOutput()),
      summary: summaryOutput({ recommendations }),
    });
    return (await runEngagement(request(), fake.callModel)).report.recommendations;
  };

  const [rewritten] = await run(["tension_drop"], [QUIET_REMOVAL]);
  assert.deepEqual(rewritten, {
    id: "R01",
    priority: "low",
    action: "alternative_scene",
    sceneRefs: ["S03"],
    problem: "S03 is slow and low in tension.",
    whyItMatters: QUIET_SCENE_TEXT.whyItMatters,
    alternative: QUIET_SCENE_TEXT.alternative,
    benefit: QUIET_SCENE_TEXT.benefit,
  });
  assert.equal((await run([], [QUIET_REMOVAL]))[0].action, "alternative_scene", "no flags at all: nothing justifies removal");
  assert.equal((await run(["weak_transition"], [QUIET_REMOVAL]))[0].action, "alternative_scene", "a weak transition is fixed, not cut");

  const [kept] = await run(["repetitive", "tension_drop"], [QUIET_REMOVAL]);
  assert.equal(kept.action, "pacing");
  assert.equal(kept.alternative, QUIET_REMOVAL.alternative, "a scene that repeats another may be cut");

  const covered = await run(["tension_drop"], [
    QUIET_REMOVAL,
    recommendation({ action: "emotional_payoff", sceneRefs: ["S03_SH01"], problem: "Mara's grief in S03 is only shown once." }),
  ]);
  assert.deepEqual(
    covered.map(({ action }) => action),
    ["emotional_payoff"],
    "dropped when another recommendation already covers the scene",
  );

  const unnamed = recommendation({ sceneRefs: [], alternative: "Consider removing the quiet scene entirely." });
  assert.equal((await run(["tension_drop"], [unnamed]))[0].action, "alternative_scene", "a removal that names no scene can't be justified");
  assert.deepEqual(REMOVAL_REASONS, ["repetitive", "no_story_change", "exposition_heavy"]);
});

test("removal is detected by pattern, and editing language is not mistaken for it", () => {
  const targets = (alternative: string, sceneRefs: string[] = ["S03"]) => removalTargets(recommendation({ alternative, sceneRefs }), PLAN);
  assert.deepEqual(targets("Cut S03 and go straight to dawn."), [2]);
  assert.deepEqual(targets("Consider removing this scene.", ["S03", "S04_SH01"]), [2, 3]);
  assert.deepEqual(targets("S04 could be dropped.", ["S03"]), [3]);
  assert.deepEqual(targets("Drop the quiet scene 3 altogether."), [2]);
  assert.deepEqual(targets("We could get rid of S2."), [1]);
  for (const editing of [
    "Use a hard cut to S04.",
    "Cut S03 down to two short shots.",
    "Cut straight from S02 into S04's sunrise.",
    "There is a tension drop in S03; add a sound from below.",
    "Remove S03_SH02 and hold on Mara's face.",
    "Trim S03 by ten seconds.",
    "The scene cuts to black.",
  ]) {
    assert.equal(targets(editing), null, editing);
  }
});

// --- Claims about real audiences ---

test("percentages, scores out of N, drop-off, retention and box-office claims never survive", () => {
  const cases: [string, string][] = [
    ["The hook is clear. 40% of viewers will stop watching at S03.", "The hook is clear."],
    ["Strong opening! Expect a drop-off in the middle.", "Strong opening!"],
    ["This could do well at the box office. Mara's choice lands.", "Mara's choice lands."],
    ["Audience retention dips here. The rain shot is calm.", "The rain shot is calm."],
    ["Viewers are likely to lose interest during S03. Keep it short.", "Keep it short."],
    ["I'd rate the tension 4/5. It builds.", "It builds."],
    ["Audiences will love the ending.", ""],
    ["The film could go viral.", ""],
    ["An engrossing opening. The audience learns who Wil is.", "An engrossing opening. The audience learns who Wil is."],
    ["The tension is about eighty percent there.", ""],
  ];
  for (const [input, expected] of cases) assert.equal(withoutRetentionClaims(input), expected, input);
});

test("no percentage, drop-off or box-office text survives anywhere in the report", async (t) => {
  quiet(t);
  const claim = "Expect 35% drop-off and weak box office numbers.";
  const fake = fakeModel({
    scene: () =>
      sceneOutput({
        summary: `Mara climbs. ${claim}`,
        strengths: [claim, "A clear question."],
        pacing: "Viewers will tune out in the long shots.",
        improvements: ["Shorten S03_SH02. Retention improves by 20%."],
      }),
    summary: summaryOutput({
      summary: `A clear story. ${claim}`,
      keyFactors: [claim, "A clear question in the first shot."],
      dimensions: dimensions().map((entry) => ({ ...entry, explanation: `${entry.explanation} About 60% of viewers stay.` })),
      curveNotes: [{ sceneId: "S03", note: "Watch time falls here." }],
      recommendations: [recommendation({ benefit: "Fewer viewers will click away; a 15% lift." })],
    }),
  });
  const { report } = await runEngagement(request(), fake.callModel);
  const text = JSON.stringify(report);
  for (const banned of [/%/, /percent/i, /drop-?off/i, /box office/i, /retention/i, /watch time/i, /tune out/i, /click away/i]) {
    assert.ok(!banned.test(text), String(banned));
  }
  assert.equal(report.scenes[0].summary, "Mara climbs.");
  assert.deepEqual(report.scenes[0].strengths, ["A clear question."]);
  assert.deepEqual(report.keyFactors, ["A clear question in the first shot."]);
  assert.deepEqual(report.curveNotes, []);
  assert.equal(report.recommendations.length, 0, "a recommendation left without a benefit is dropped");
});

// --- Prompt cache, failures and usage ---

const prewarmUsage: UsageRecord = { step: "engagement", model: "gpt-test", inputTokens: 2_500, outputTokens: 0, totalTokens: 2_500 };

test("the shared scene prefix is prewarmed once when worthwhile, and every scene call reads it", async (t) => {
  quiet(t);
  const fake = fakeModel({ prewarm: async () => prewarmUsage });
  const { usage } = await runEngagement(request(), fake.callModel);
  assert.deepEqual(fake.events.slice(0, 2), ["prewarm", "scene 1"]);
  assert.equal(fake.prewarms.length, 1);
  const [prewarm] = fake.prewarms;
  assert.equal(prewarm.stage, "engagement_scene");
  assert.deepEqual(sectionTitles(prewarm.cachedPrefix), [SECTION.film, SECTION.memory, SECTION.source, SECTION.scenes]);
  assert.ok(prewarm.cachedPrefix.endsWith("\n"));
  for (const call of fake.sceneCalls()) {
    assert.equal(call.cachedPrefix, prewarm.cachedPrefix);
    assert.deepEqual(sectionTitles(call.input), [SECTION.sceneToAssess]);
    assert.equal(call.instructions, prewarm.instructions);
    assert.equal(call.schema, prewarm.schema);
    assert.equal(call.maxOutputTokens, prewarm.maxOutputTokens);
  }
  assert.deepEqual(
    usage.map(({ step, inputTokens }) => [step, inputTokens]),
    [
      ["engagement", 2_500],
      ["engagement", 101],
      ["engagement", 102],
      ["engagement", 103],
      ["engagement", 104],
      ["engagement", 900],
    ],
    "one record per call: prewarm, each scene in plan order, then the summary",
  );
});

test("a single scene or a failed prewarm runs uncached and the report still succeeds", async (t) => {
  quiet(t);
  const single = fakeModel({ prewarm: async () => prewarmUsage });
  await runEngagement(request({ ...PLAN, scenes: PLAN.scenes.slice(0, 1) }), single.callModel);
  assert.equal(single.prewarms.length, 0);

  const failing = fakeModel({
    prewarm: async () => {
      throw new ModelOutputError("Prompt cache not written", prewarmUsage, "no_cache_write");
    },
  });
  const { usage, report } = await runEngagement(request(), failing.callModel);
  assert.equal(report.scenes.length, 4);
  for (const call of failing.sceneCalls()) {
    assert.equal(call.cachedPrefix, undefined);
    assert.deepEqual(sectionTitles(call.input), [SECTION.film, SECTION.memory, SECTION.source, SECTION.scenes, SECTION.sceneToAssess]);
  }
  assert.equal(usage.length, 6, "the failed prewarm still cost tokens");
});

test("some scenes failing still gives a report; more than half failing is an error that carries the usage", async (t) => {
  quiet(t);
  const invalid = fakeModel({ scene: (scene) => (scene === 1 ? { summary: "only a summary" } : sceneOutput()) });
  const partial = await runEngagement(request(), invalid.callModel);
  assert.deepEqual(partial.report.scenes.map(({ status }) => status), ["failed", "ok", "ok", "ok"]);
  assert.equal(partial.usage.length, 5, "an invalid answer still cost tokens");

  const half = fakeModel({ scene: (scene) => (scene <= 2 ? Promise.reject(new Error("down")) : sceneOutput()) });
  const halfResult = await runEngagement(request(), half.callModel);
  assert.equal(halfResult.report.scenes.filter(({ status }) => status === "failed").length, 2, "exactly half is still a report");

  const most = fakeModel({ scene: (scene) => (scene <= 3 ? sceneOutput({ ratings: undefined as never }) : sceneOutput()) });
  await assert.rejects(runEngagement(request(), most.callModel), (error: unknown) => {
    assert.ok(error instanceof EngagementError);
    assert.equal(error.failure, "scenes");
    assert.ok(error.cause instanceof ModelOutputError);
    assert.deepEqual(error.usage.map(({ inputTokens }) => inputTokens), [101, 102, 103, 104]);
    return true;
  });
  assert.equal(most.summaryCall(), undefined, "no summary when the scenes failed");
});

test("a failed or invalid summary is an error carrying every call's usage", async (t) => {
  quiet(t);
  const invalid = fakeModel({ summary: { summary: "No dimensions" } });
  await assert.rejects(runEngagement(request(), invalid.callModel), (error: unknown) => {
    assert.ok(error instanceof EngagementError);
    assert.equal(error.failure, "summary");
    assert.deepEqual(error.usage.map(({ inputTokens }) => inputTokens), [101, 102, 103, 104, 900]);
    return true;
  });
  const hung = fakeModel({ summary: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(runEngagement(request(), hung.callModel, { summaryTimeoutMs: 20 }), EngagementError);
  assert.ok(Date.now() - started < 1_000);
});

test("a hung scene call times out as a failed scene, not a hung report", async (t) => {
  quiet(t);
  const fake = fakeModel({ scene: (scene) => (scene === 4 ? new Promise(() => {}) : sceneOutput()) });
  const started = Date.now();
  const { report } = await runEngagement(request(), fake.callModel, { sceneTimeoutMs: 30 });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(report.scenes[3].status, "failed");
});

test("the report validates against the shared schema once the client adds createdAt and planSignature", async (t) => {
  quiet(t);
  const fake = fakeModel({ summary: summaryOutput({ recommendations: [recommendation()], curveNotes: [{ sceneId: "S02", note: "The rescue lifts it." }] }) });
  const { report } = await runEngagement(request(), fake.callModel);
  assert.ok(!("createdAt" in report) && !("planSignature" in report));
  assert.ok(engagementReportSchema.safeParse({ ...report, createdAt: 1, planSignature: "sig" }).success);
  assert.equal(report.version, 1);
});

test("logs carry metadata only, never story text", async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => logged.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => logged.push(args));
  const fake = fakeModel({ scene: (scene) => (scene === 2 ? Promise.reject(new Error("Mara drags a sailor")) : sceneOutput()) });
  await runEngagement(request(), fake.callModel);
  const text = JSON.stringify(logged);
  assert.ok(text.includes("Engagement report") && text.includes("Engagement scene failed"));
  for (const secret of ["Mara", "SOURCE STORY TEXT", "Storm night", "lighthouse"]) assert.ok(!text.includes(secret), secret);
});

// --- Brain ---

test("the brain states the stance, names every id the schemas accept and matches the code's limits", () => {
  const scene = composeInstructions("engagement_scene", "short_film");
  const summary = composeInstructions("engagement_summary", "short_film");
  for (const text of [scene, summary]) {
    assert.ok(text.includes("not measured audience retention"));
    assert.ok(text.includes("Never recommend removing or cutting a scene just because it is quiet"));
    assert.ok(text.includes("never give percentages, drop-off, watch time, retention or box-office predictions"));
    assert.ok(text.includes("give score null with insufficient true instead of guessing"));
    assert.ok(text.includes("You never change the story"));
    for (const dimension of ENGAGEMENT_DIMENSIONS) assert.ok(text.includes(`- ${dimension} (`), dimension);
    for (const band of ["85 or more", "70–84", "50–69", "30–49", "under 30"]) assert.ok(text.includes(band), band);
  }
  for (const flag of SCENE_FLAGS) assert.ok(scene.includes(`${flag} (`), flag);
  for (const action of RECOMMENDATION_ACTIONS) assert.ok(summary.includes(`${action} (`), action);
  assert.ok(summary.includes(`at most ${MAX_RECOMMENDATIONS}`));
  assert.ok(summary.includes(`curveNotes (at most ${MAX_CURVE_NOTES}:`));
  assert.ok(summary.includes("Don't give an overall score"));
  const notes = (count: number) => Array.from({ length: count }, () => ({ sceneId: "S01", note: "n" }));
  const base = { ...summaryOutput(), version: 1, createdAt: 1, planSignature: "s", overall: { score: null, summary: "" }, dimensions: dimensions().map((entry) => ({ ...entry, score: null, insufficient: true })), scenes: [], strongest: [], weakest: [] };
  assert.ok(engagementReportSchema.safeParse({ ...base, curveNotes: notes(MAX_CURVE_NOTES) }).success);
  assert.ok(!engagementReportSchema.safeParse({ ...base, curveNotes: notes(MAX_CURVE_NOTES + 1) }).success);
});

// --- Route ---

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/story/engagement", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

async function withKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.OPENAI_API_KEY;
  if (key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = key;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("POST /api/story/engagement validates and bounds the request before needing a key", async () => {
  assert.equal(maxDuration, 180);
  await withKey(undefined, async () => {
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post({ plan: PLAN })).status, 400, "title is required");
    assert.equal((await post({ ...request(), source: "x".repeat(26_001) })).status, 400);
    assert.equal((await post(request(), { "content-length": "1000001" })).status, 413);
    const noScenes = await post(request({ ...PLAN, scenes: [] }));
    assert.equal(noScenes.status, 400);
    assert.equal((await noScenes.json()).error, NO_SCENES_MESSAGE);
    const tooMany = await post(request({ ...PLAN, scenes: Array.from({ length: MAX_ENGAGEMENT_SCENES + 1 }, () => PLAN.scenes[0]) }));
    assert.equal(tooMany.status, 400);
    assert.equal((await tooMany.json()).error, TOO_MANY_SCENES_MESSAGE);
    const noKey = await post(request());
    assert.equal(noKey.status, 503);
    assert.match((await noKey.json()).error, /OPENAI_API_KEY/);
  });
});

function mockOpenAI(t: { after: (fn: () => void) => void }, respond: (body: Record<string, unknown>) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.ok(url.startsWith("https://api.openai.com/"), url);
    return respond(JSON.parse(String(init?.body)) as Record<string, unknown>);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

const responsesBody = (output: unknown, details: Record<string, number> = {}) => ({
  id: "resp_test",
  object: "response",
  created_at: 0,
  status: "completed",
  incomplete_details: null,
  model: "gpt-test",
  output: [
    {
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
    },
  ],
  usage: { input_tokens: 1_000, input_tokens_details: details, output_tokens: 200, total_tokens: 1_200 },
});

test("POST maps scene failures to a plain 502 with usage, and account errors to their own status", async (t) => {
  quiet(t);
  let status = 500;
  mockOpenAI(t, () => json({ error: { message: "boom", type: "server_error" } }, status));
  await withKey("sk-test-not-real", async () => {
    const failed = await post(request());
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: ENGAGEMENT_FAILED_MESSAGE, usage: [] });
    status = 401;
    const account = await post(request());
    assert.equal(account.status, 503);
    assert.match((await account.json()).error, /API key/);
    status = 429;
    assert.equal((await post(request())).status, 429);
  });
});

test("POST returns 502 with every usage record when the summary fails", async (t) => {
  quiet(t);
  mockOpenAI(t, (body) => {
    const summary = String(body.instructions).includes("Write the summary of an engagement potential report");
    if (summary) return json({ error: { message: "boom", type: "server_error" } }, 500);
    const prewarm = (body.prompt_cache_options as { prewarm?: boolean }).prewarm;
    return json(responsesBody(sceneOutput(), prewarm ? { cache_write_tokens: 900 } : {}));
  });
  const response = await withKey("sk-test-not-real", () => post(request()));
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: string; usage: UsageRecord[] };
  assert.equal(body.error, ENGAGEMENT_FAILED_MESSAGE);
  assert.equal(body.usage.length, 5, "the prewarm and four scenes");
});

test("POST returns the report and one usage record per call through the real model caller", async (t) => {
  quiet(t);
  const seen: { stage: string; verbosity?: string; prewarm: boolean; cached: boolean }[] = [];
  mockOpenAI(t, (body) => {
    const summary = String(body.instructions).includes("Write the summary of an engagement potential report");
    const prewarm = Boolean((body.prompt_cache_options as { prewarm?: boolean }).prewarm);
    seen.push({
      stage: summary ? "summary" : "scene",
      verbosity: (body.text as { verbosity?: string }).verbosity,
      prewarm,
      cached: Array.isArray(body.input),
    });
    if (summary) return json(responsesBody(summaryOutput({ recommendations: [recommendation()] })));
    return json(responsesBody(sceneOutput({ evidence: ["S01_SH01"] }), prewarm ? { cache_write_tokens: 900 } : { cached_tokens: 800 }));
  });
  const response = await withKey("sk-test-not-real", () => post(request()));
  assert.equal(response.status, 200);
  const { report, usage } = (await response.json()) as { report: Record<string, unknown>; usage: UsageRecord[] };
  assert.ok(engagementReportSchema.safeParse({ ...report, createdAt: 1, planSignature: "sig" }).success);
  assert.deepEqual(seen.map(({ stage, prewarm }) => (prewarm ? "prewarm" : stage)), ["prewarm", "scene", "scene", "scene", "scene", "summary"]);
  assert.ok(seen.every(({ verbosity }) => verbosity === "low"));
  assert.ok(seen.filter(({ stage }) => stage === "scene").every(({ cached }) => cached), "scene calls read the cached prefix");
  assert.equal(usage.length, 6);
  assert.ok(usage.every(({ step }) => step === "engagement"));
  assert.equal(usage[0].cacheWriteTokens, 900);
  assert.equal(usage[1].cachedTokens, 800);
});
