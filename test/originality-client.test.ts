import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { selectSpecialists } from "../src/lib/agents/router.ts";
import {
  DIMENSION_LABELS,
  dismissKey,
  MAX_DISMISSED,
  NO_CONCERNS_MESSAGE,
  type OriginalityFinding,
  type OriginalityReport,
} from "../src/lib/originality.ts";
import {
  checkedAtLabel,
  decidedFactsFor,
  dismissedHeading,
  FINDING_ACTION_HINTS,
  FINDING_ACTION_LABELS,
  FINDING_ACTIONS,
  findingActionMessage,
  findingReference,
  isReportOutOfDate,
  lookupNote,
  modeLabel,
  moreLabel,
  ORIGINALITY_COPY,
  overallStatus,
  SEVERITY_LABELS,
  safeSourceUrl,
  splitFindings,
} from "../src/lib/originality-ui.ts";
import { ORIGINALITY_ACTION } from "../src/lib/quick-actions.ts";
import { REPORT_CONFIRM_COPY } from "../src/lib/report-confirm.ts";
import { createSession, parseSessions, planSignature, serializeSessions, type StorySession } from "../src/lib/session.ts";
import type { StoryContext } from "../src/lib/story-context.ts";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "../src/lib/story-input.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";
import {
  checkOriginality,
  withDismissedFinding,
  withOriginalityReport,
  withRestoredFinding,
} from "../src/lib/studio-agent.ts";
import type { UsageRecord } from "../src/lib/usage.ts";

const NOW = 1_764_300_000_000;

const plan: ShotPlan = {
  title: "The Keeper",
  logline: "A lighthouse keeper finds a stranger.",
  intent: "Loneliness ends.",
  characters: [{ name: "Mara", role: "Keeper", look: "Grey coat", personality: "Quiet", voice: "Low" }],
  locations: [{ name: "Pier", description: "Old wooden pier" }],
  scenes: [
    {
      title: "Storm",
      shots: [
        {
          seconds: 4,
          framing: "Wide",
          camera: "Still",
          characters: ["Mara"],
          location: "Pier",
          action: "Waves hit the pier",
          dialogue: [],
          emotion: "Tense",
          sound: "Wind",
        },
      ],
    },
  ],
  reviewNotes: [],
};

const finding = (overrides: Partial<OriginalityFinding> = {}): OriginalityFinding => ({
  id: "f1",
  dimension: "plot",
  kind: "similar_combination",
  severity: "moderate",
  title: "Washed-up stranger at a lighthouse",
  explanation: "A lonely keeper rescuing a stranger from the sea follows a well-known pattern.",
  storyRefs: ["S01", "S01_SH01"],
  storyExcerpt: "Waves hit the pier",
  suggestion: "Give the keeper a reason to hide the stranger from the village.",
  basis: "ai_review",
  referenceId: null,
  referenceEvidence: "",
  ...overrides,
});

const reference = {
  id: "ref1",
  title: "The Light Between Oceans",
  description: "2016 film by Derek Cianfrance",
  url: "https://en.wikipedia.org/wiki/The_Light_Between_Oceans_(film)",
  source: "wikipedia" as const,
  excerpt: "A lighthouse keeper and his wife rescue a baby adrift at sea.",
  retrievedAt: "2026-11-28T10:00:00.000Z",
};

function serverReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    mode: "ai_review_with_references",
    referenceLookup: { requested: true, status: "ok", checked: 2, verified: 1, note: "" },
    coverage: { plot: "checked", characters: "checked", scenes: "checked", dialogue: "not_available", structure: "checked" },
    status: "potential_similarities",
    tropes: [{ title: "Storm as a turning point", note: "Common in sea stories." }],
    findings: [
      finding(),
      finding({ id: "f2", severity: "high", basis: "reference", referenceId: "ref1", referenceEvidence: "rescue a baby adrift" }),
      finding({ id: "f3", dimension: "characters", severity: "low", kind: "broad_theme", title: "Lonely keeper" }),
    ],
    references: [reference],
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): OriginalityReport {
  return { ...serverReport(overrides), createdAt: NOW, planSignature: planSignature(plan) } as OriginalityReport;
}

const usage = (step: UsageRecord["step"], model: string, totalTokens: number): UsageRecord => ({
  step,
  model,
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

test("checkOriginality stamps createdAt and the checked plan's signature, and keeps valid usage", async () => {
  const records = [usage("originality", "test-model", 900), usage("originality-lookup", "wikipedia", 0)];
  const fetched = mockFetch({ report: serverReport(), usage: [...records, { step: "originality" }] });
  const result = await checkOriginality(
    { title: "The Keeper", plan, source: "Story text", dismissed: ["plot:old"], references: true },
    NOW,
  );
  assert.ok(result.ok);
  assert.equal(result.report.createdAt, NOW);
  assert.equal(result.report.planSignature, planSignature(plan));
  assert.equal(result.report.findings.length, 3);
  assert.deepEqual(result.usage, records);
  assert.equal(fetched.calls[0].url, "/api/story/originality");
  assert.deepEqual(Object.keys(fetched.calls[0].body).sort(), ["dismissed", "plan", "references", "source", "title"]);
});

test("checkOriginality overrides any createdAt or signature the server sends", async () => {
  mockFetch({ report: serverReport({ createdAt: 1, planSignature: "forged" }), usage: [] });
  const result = await checkOriginality({ title: "The Keeper", plan, references: false }, NOW);
  assert.ok(result.ok);
  assert.equal(result.report.createdAt, NOW);
  assert.equal(result.report.planSignature, planSignature(plan));
});

test("checkOriginality sends only the story, its context and the dismissed keys, within limits", async () => {
  const context: StoryContext = { facts: [], unresolved: [] };
  const dismissed = Array.from({ length: MAX_DISMISSED + 5 }, (_, index) => `plot:${index}`);
  const fetched = mockFetch({ report: serverReport(), usage: [] });
  await checkOriginality({ title: "  ", plan, context, source: "x".repeat(26_001), dismissed, references: false }, NOW);
  const body = fetched.calls[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["context", "dismissed", "plan", "references", "title"]);
  assert.equal(body.title, "Untitled project");
  assert.equal(body.references, false);
  assert.deepEqual(body.dismissed, dismissed.slice(-MAX_DISMISSED));
});

test("a malformed report or a server error becomes a readable error", async () => {
  mockFetch({ report: serverReport({ findings: [{ id: "broken" }] }), usage: [] });
  const malformed = await checkOriginality({ title: "T", plan, references: true }, NOW);
  assert.equal(malformed.ok, false);
  assert.ok(!malformed.ok && /incomplete/.test(malformed.error));

  mockFetch({ report: [], usage: [] });
  assert.equal((await checkOriginality({ title: "T", plan, references: true }, NOW)).ok, false);

  mockFetch({ report: serverReport({ version: 2 }) });
  assert.equal((await checkOriginality({ title: "T", plan, references: true }, NOW)).ok, false);

  mockFetch({ error: "The originality check is busy. Try again in a minute." }, 503);
  const failed = await checkOriginality({ title: "T", plan, references: true }, NOW);
  assert.deepEqual(failed, { ok: false, error: "The originality check is busy. Try again in a minute." });
});

test("a new report keeps earlier dismissals; dismiss and undo are persisted and capped", () => {
  const session: StorySession = { ...createSession("The Keeper"), phase: "refining", plan };
  assert.equal(withDismissedFinding(session, finding()), session);

  const first = withOriginalityReport(session, report());
  assert.deepEqual(first.originality?.dismissed, []);
  const dismissed = withDismissedFinding(first, finding());
  assert.deepEqual(dismissed.originality?.dismissed, [dismissKey(finding())]);
  assert.deepEqual(withDismissedFinding(dismissed, finding()).originality?.dismissed, [dismissKey(finding())]);

  const rechecked = withOriginalityReport(dismissed, report({ findings: [] }));
  assert.deepEqual(rechecked.originality?.dismissed, [dismissKey(finding())]);
  assert.deepEqual(rechecked.originality?.report.findings, []);

  const restored = withRestoredFinding(dismissed, finding());
  assert.deepEqual(restored.originality?.dismissed, []);

  let full = first;
  for (let index = 0; index < MAX_DISMISSED + 3; index += 1) {
    full = withDismissedFinding(full, finding({ title: `Finding ${index}` }));
  }
  const keys = full.originality?.dismissed ?? [];
  assert.equal(keys.length, MAX_DISMISSED);
  assert.equal(keys.at(-1), dismissKey(finding({ title: `Finding ${MAX_DISMISSED + 2}` })));
  assert.ok(!keys.includes(dismissKey(finding({ title: "Finding 0" }))));

  const reloaded = parseSessions(JSON.stringify(serializeSessions([full], full.id))).sessions[0];
  assert.deepEqual(reloaded.originality, full.originality);
});

test("the report is out of date once the plan changes", () => {
  const checked = report();
  assert.equal(isReportOutOfDate(plan, checked), false);
  assert.equal(isReportOutOfDate({ ...plan, logline: "Changed" }, checked), true);
  assert.equal(isReportOutOfDate(null, checked), true);
});

test("Apply revision asks first only about filmmaker or approved facts in the related categories", () => {
  const context: StoryContext = {
    unresolved: [],
    facts: [
      { category: "concept", label: "Idea", value: "Keeper finds stranger", source: "user", approved: true },
      { category: "structure", label: "Ending", value: "They leave together", source: "ai", approved: true },
      { category: "structure", label: "Middle", value: "A storm", source: "ai", approved: false },
      { category: "characters", label: "Main character", value: "Mara", source: "user", approved: true },
      { category: "dialogue", label: "Language", value: "English", source: "user", approved: true },
      { category: "locations", label: "Place", value: "Pier", source: "ai", approved: true },
    ],
  };
  const labels = (dimension: OriginalityFinding["dimension"]) => decidedFactsFor(context, dimension).map((fact) => fact.label);
  assert.deepEqual(labels("plot"), ["Idea", "Ending"]);
  assert.deepEqual(labels("characters"), ["Main character"]);
  assert.deepEqual(labels("scenes"), ["Place"]);
  assert.deepEqual(labels("dialogue"), ["Language"]);
  assert.deepEqual(labels("structure"), ["Ending"]);
  assert.deepEqual(decidedFactsFor(undefined, "plot"), []);
});

test("Discuss and Suggest name the finding and ask not to change the board", () => {
  const item = finding();
  for (const action of ["discuss", "alternatives"] as const) {
    const message = findingActionMessage(action, item);
    for (const part of [item.title, DIMENSION_LABELS.plot, SEVERITY_LABELS.moderate, "S01, S01_SH01", item.explanation]) {
      assert.ok(message.includes(part), `${action}: ${part}`);
    }
    assert.ok(message.includes("Don’t change the board yet"), action);
  }
  assert.ok(findingActionMessage("alternatives", item).includes("2–3"));
  assert.ok(findingActionMessage("alternatives", item).includes(item.suggestion));
});

test("Apply revision asks to revise only the named parts, following the suggestion", () => {
  const message = findingActionMessage("revise", finding());
  assert.ok(message.startsWith("Revise only these parts: S01, S01_SH01."));
  assert.ok(message.includes(finding().suggestion));
  assert.ok(message.includes(finding().title));
  assert.ok(!message.includes("Don’t change the board"));
  assert.ok(findingActionMessage("revise", finding({ storyRefs: [] })).startsWith("Revise only the part this finding is about."));
});

test("action messages route as intended: discussion to the story expert, revision to the plan edit", () => {
  const neutral = finding({ title: "Rescue at the pier", explanation: "Close to a known film.", suggestion: "Change who arrives." });
  assert.ok(selectSpecialists(findingActionMessage("discuss", neutral)).includes("story-analyst"));
  assert.ok(selectSpecialists(findingActionMessage("alternatives", neutral)).includes("story-analyst"));
  assert.deepEqual(selectSpecialists(findingActionMessage("revise", neutral)), []);
});

test("action messages fit in one chat message even for the longest finding", () => {
  const longest = finding({
    title: "t".repeat(160),
    explanation: "e".repeat(1_200),
    suggestion: "s".repeat(800),
    storyRefs: Array.from({ length: 12 }, (_, index) => `S${index + 10}_SH10`),
  });
  for (const action of FINDING_ACTIONS) {
    assert.ok(findingActionMessage(action, longest).length <= MAX_CHAT_MESSAGE_CHARACTERS, action);
  }
});

test("status: the exact no-concerns message, open concerns, or everything significant dismissed", () => {
  assert.deepEqual(overallStatus(report({ status: "no_significant_concerns", findings: [] }), []), {
    tone: "clear",
    text: NO_CONCERNS_MESSAGE,
  });
  assert.equal(overallStatus(report(), []).tone, "concern");
  const significant = report().findings.filter((item) => item.severity !== "low").map(dismissKey);
  assert.equal(overallStatus(report(), significant).tone, "dismissed");
});

test("findings are grouped High, Moderate, Low; dismissed ones move to their own list", () => {
  const all = report().findings;
  const { groups, dismissed } = splitFindings(all, [dismissKey(all[2])]);
  assert.deepEqual(
    groups.map((group) => [group.severity, group.findings.map((item) => item.id)]),
    [
      ["high", ["f2"]],
      ["moderate", ["f1"]],
    ],
  );
  assert.deepEqual(
    dismissed.map((item) => item.id),
    ["f3"],
  );
});

test("mode label, lookup note, references and links", () => {
  assert.equal(modeLabel(report({ mode: "ai_review" })), "AI-based originality review");
  assert.equal(modeLabel(report()), "AI review + reference check (1 verified source)");
  assert.equal(
    modeLabel(report({ referenceLookup: { requested: true, status: "ok", checked: 3, verified: 2, note: "" } })),
    "AI review + reference check (2 verified sources)",
  );
  assert.equal(lookupNote(report()), null);
  assert.deepEqual(
    lookupNote(report({ referenceLookup: { requested: true, status: "partial", checked: 2, verified: 1, note: "One lookup failed." } })),
    { text: "One lookup failed.", warning: true },
  );
  const [aiFinding, referenced] = report().findings;
  assert.equal(findingReference(aiFinding, [reference]), null);
  assert.equal(findingReference(referenced, [reference])?.title, reference.title);
  assert.equal(findingReference({ ...referenced, referenceId: "missing" }, [reference]), null);
  assert.equal(safeSourceUrl(reference.url), reference.url);
  assert.equal(safeSourceUrl("javascript:alert(1)"), null);
  assert.equal(safeSourceUrl("http://en.wikipedia.org/wiki/X"), null);
  assert.equal(safeSourceUrl("not a url"), null);
});

test("no UI copy shows percentages, originality guarantees or legal conclusions", () => {
  const copy = [
    ...Object.values(ORIGINALITY_COPY),
    ...Object.values(FINDING_ACTION_LABELS),
    ...Object.values(FINDING_ACTION_HINTS),
    ...Object.values(SEVERITY_LABELS),
    ORIGINALITY_ACTION.label,
    ORIGINALITY_ACTION.shortLabel,
    ORIGINALITY_ACTION.tooltip,
    REPORT_CONFIRM_COPY.originality.title,
    REPORT_CONFIRM_COPY.originality.text,
    REPORT_CONFIRM_COPY.originality.option?.label ?? "",
    REPORT_CONFIRM_COPY.originality.option?.note ?? "",
    dismissedHeading(3),
    checkedAtLabel("28 Nov 2026"),
    moreLabel(2),
    modeLabel(report()),
    modeLabel(report({ mode: "ai_review" })),
  ];
  for (const text of copy) {
    assert.doesNotMatch(text, /%|percent|plagiari|100\s*%|guarantee|infring|copyright|legal|lawful|original\s*score/i, text);
  }
});
