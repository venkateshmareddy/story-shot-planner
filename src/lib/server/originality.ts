import { z } from "zod";
import { clip, shotId } from "@/lib/agents/shared";
import { DEFAULT_FORMAT } from "@/lib/formats";
import {
  dismissKey,
  FINDING_KINDS,
  MAX_FINDINGS,
  MAX_REFERENCE_EXCERPT,
  MAX_REFERENCES,
  MAX_TROPES,
  ORIGINALITY_DIMENSIONS,
  type OriginalityFinding,
  type OriginalityReport,
  type OriginalityRequest,
  type OriginalitySeverity,
  originalityReportSchema,
  type ReferenceWork,
  SEVERITIES,
} from "@/lib/originality";
import {
  contextFacts,
  fenced,
  listSection,
  memorySection,
  oneLine,
  SECTION,
  section,
  sections,
  textSection,
} from "@/lib/server/memory-view";
import { type CallModel, deadline, ModelOutputError, modelErrorMetadata, untilAborted } from "@/lib/server/openai";
import { composeInstructions } from "@/lib/server/prompts";
import { lookupWork, WORK_MEDIA, type WikipediaFetch, type WikipediaWork, type WorkLookup } from "@/lib/server/wikipedia";
import { EMPTY_CONTEXT } from "@/lib/story-context";
import type { ShotPlan } from "@/lib/story-planning";
import type { UsageRecord } from "@/lib/usage";

export const ORIGINALITY_BODY_BYTES = 1_000_000;
export const REVIEW_MAX_OUTPUT_TOKENS = 3_500;
export const REVIEW_TIMEOUT_MS = 75_000;
export const COMPARE_MAX_OUTPUT_TOKENS = 2_500;
export const COMPARE_TIMEOUT_MS = 60_000;
export const MAX_COMPARE_EXTRACT = 1_200;
const MAX_STORY_REFS = 12;
const DUPLICATE_TITLE_SIMILARITY = 0.8;
const NEUTRAL_WORK = "an existing work";
const DEFAULT_SUGGESTION = "Consider making this part more distinctive.";

export const ORIGINALITY_FAILED_MESSAGE = "The originality check couldn’t finish. Your story is unchanged — try again.";
export const NOTHING_TO_CHECK_MESSAGE = "Add a story or scenes before checking originality.";

const findingFields = {
  dimension: z.enum(ORIGINALITY_DIMENSIONS),
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  explanation: z.string(),
  storyRefs: z.array(z.string()),
  storyExcerpt: z.string(),
};

export const originalityReviewOutput = z.object({
  tropes: z.array(z.object({ title: z.string(), note: z.string() })),
  findings: z.array(z.object({ ...findingFields, suggestion: z.string() })),
  candidates: z.array(
    z.object({ title: z.string(), year: z.number().nullable(), medium: z.enum(WORK_MEDIA), why: z.string() }),
  ),
});
export type OriginalityReviewOutput = z.infer<typeof originalityReviewOutput>;

export const originalityCompareOutput = z.object({
  findings: z.array(
    z.object({ referenceId: z.string(), ...findingFields, referenceEvidence: z.string(), suggestion: z.string() }),
  ),
});
export type OriginalityCompareOutput = z.infer<typeof originalityCompareOutput>;

// The client adds createdAt and planSignature when it stores the report.
export type OriginalityCheck = Omit<OriginalityReport, "createdAt" | "planSignature">;
const originalityCheckSchema = originalityReportSchema.omit({ createdAt: true, planSignature: true });

export type OriginalityResult = { report: OriginalityCheck; usage: UsageRecord[] };

export type OriginalityDeps = { callModel: CallModel; fetch?: WikipediaFetch; now?: () => Date };

export type OriginalityOptions = {
  signal?: AbortSignal;
  reviewTimeoutMs?: number;
  compareTimeoutMs?: number;
  lookupTimeoutMs?: number;
};

type Coverage = OriginalityReport["coverage"];
type ReferenceLookup = OriginalityReport["referenceLookup"];
type Trope = OriginalityReport["tropes"][number];
type DraftFinding = Omit<OriginalityFinding, "id">;
type ModelFinding = OriginalityReviewOutput["findings"][number];
type Candidate = OriginalityReviewOutput["candidates"][number];

const SEVERITY_RANK: Record<OriginalitySeverity, number> = { low: 0, moderate: 1, high: 2 };

const LOOKUP_USAGE: UsageRecord = { step: "originality-lookup", model: "wikipedia", inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const sceneId = (index: number) => `S${String(index + 1).padStart(2, "0")}`;

const hasDialogue = (plan: ShotPlan) =>
  plan.scenes.some(({ shots }) => shots.some(({ dialogue }) => dialogue.some(({ line }) => line.trim())));

const hasPlanContent = (plan: ShotPlan) =>
  plan.scenes.length > 0 || plan.characters.length > 0 || [plan.logline, plan.intent].some((text) => text.trim());

export function hasStoryToCheck(request: Pick<OriginalityRequest, "plan" | "source">): boolean {
  return hasPlanContent(request.plan) || Boolean(request.source?.trim());
}

export function originalityCoverage(plan: ShotPlan): Coverage {
  const checked = (yes: boolean) => (yes ? "checked" : "not_available");
  const content = checked(hasPlanContent(plan));
  return {
    plot: content,
    characters: content,
    scenes: checked(plan.scenes.length > 0),
    dialogue: checked(hasDialogue(plan)),
    structure: content,
  };
}

function planStrings(plan: ShotPlan): string[] {
  return [
    plan.title,
    plan.logline,
    plan.intent,
    ...plan.characters.flatMap(({ name, role, personality }) => [name, role, personality]),
    ...plan.locations.map(({ name }) => name),
    ...plan.scenes.flatMap(({ title, shots }) => [
      title,
      ...shots.flatMap(({ action, dialogue }) => [action, ...dialogue.map(({ line }) => line)]),
    ]),
  ].filter((text) => text.trim());
}

export function planSection(plan: ShotPlan, fallbackTitle: string): string {
  const characters = plan.characters.map(({ name, role, personality }) =>
    `- ${[name, role, personality].map(oneLine).filter(Boolean).join(" — ")}`,
  );
  const places = plan.locations.map(({ name }) => oneLine(name)).filter(Boolean);
  return section(SECTION.planText, [
    `Title: ${oneLine(plan.title) || oneLine(fallbackTitle)}`,
    plan.logline.trim() ? `Logline: ${oneLine(plan.logline)}` : "",
    plan.intent.trim() ? `Intent: ${oneLine(plan.intent)}` : "",
    ...(characters.length ? ["Characters:", ...characters] : []),
    places.length ? `Places: ${places.join("; ")}` : "",
    ...plan.scenes.flatMap((scene, sceneIndex) => [
      `${sceneId(sceneIndex)} · ${oneLine(scene.title)}`,
      ...scene.shots.flatMap((shot, shotIndex) => [
        `- ${shotId(sceneIndex, shotIndex)}: ${oneLine(shot.action)}`,
        ...shot.dialogue
          .filter(({ line }) => line.trim())
          .map(({ speaker, line }) => `  ${oneLine(speaker) || "Someone"}: ${oneLine(line)}`),
      ]),
    ]),
  ].filter(Boolean));
}

// Unapproved AI suggestions aren't the filmmaker's story, so they can't be what resembles another work.
function confirmedMemory(request: OriginalityRequest): string {
  return memorySection(contextFacts(request.context ?? EMPTY_CONTEXT).filter(({ status }) => status !== "ai_suggestion"));
}

export function reviewInput(request: OriginalityRequest): string {
  return sections(
    confirmedMemory(request),
    textSection(SECTION.source, request.source),
    planSection(request.plan, request.title),
    listSection(SECTION.dismissed, request.dismissed ?? []),
  );
}

const SCORE =
  /\s*\(?(?:\b(?:about|around|roughly|approximately|nearly|almost|over|under)\s+)?~?\b\d+(?:[.,]\d+)?\s*(?:%|\bper\s*cent\b|\bpercent\b|\/\s*(?:5|10|100)\b|\bout of (?:5|10|100)\b)\)?/gi;

export function withoutScores(text: string): string {
  return text
    .replace(SCORE, "")
    .replace(/%/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

const CAREFUL_WORDING: readonly [RegExp, string][] = [
  [/\bcopyright infringement\b/gi, "close similarity"],
  [/\bplagiari[sz]ing\b/gi, "closely resembling"],
  [/\bplagiari[sz]ed\b/gi, "closely similar"],
  [/\bplagiari[sz]es\b/gi, "closely resembles"],
  [/\bplagiari[sz]e\b/gi, "closely resemble"],
  [/\bplagiarism\b/gi, "close similarity"],
  [/\binfringement\b/gi, "close similarity"],
  [/\binfringing\b/gi, "closely resembling"],
  [/\binfringes\b/gi, "closely resembles"],
  [/\binfringe\b/gi, "closely resemble"],
];

export function carefulWording(text: string): string {
  return CAREFUL_WORDING.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const QUOTE_OPEN = `["“‘'*_]`;
const QUOTE_CLOSE = `["”’'*_]`;

function workNames(titles: readonly string[]): string[] {
  const names = titles.flatMap((title) => [oneLine(title), oneLine(title.replace(/\s*\([^)]*\)\s*$/, ""))]);
  return [...new Set(names.filter((name) => name.length >= 2))].sort((a, b) => b.length - a.length);
}

// A one-word title is replaced only when quoted, in italics or followed by a year, so "Her" never eats an ordinary "Her".
export function withoutWorkNames(text: string, names: readonly string[]): string {
  return names.reduce((result, name) => {
    const title = escapeRegExp(name);
    const year = String.raw`(?:\s*\(\d{4}\))?`;
    const quoted = new RegExp(`${QUOTE_OPEN}${title}${QUOTE_CLOSE}${year}`, "gu");
    const replaced = result.replace(quoted, NEUTRAL_WORK);
    const bare = /\s/.test(name) ? String.raw`${title}(?![\p{L}\p{N}])${year}` : String.raw`${title}\s*\(\d{4}\)`;
    return replaced.replace(new RegExp(String.raw`(?<![\p{L}\p{N}])${bare}`, "gu"), NEUTRAL_WORK);
  }, text);
}

const QUOTE_FOLD: Record<string, string> = { "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'" };

function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let space = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (space) continue;
      space = true;
      folded += " ";
    } else {
      space = false;
      const quote = QUOTE_FOLD[char] ?? char;
      const lower = quote.toLowerCase();
      folded += lower.length === 1 ? lower : quote;
    }
    map.push(index);
  }
  return { folded, map };
}

const stripQuoteMarks = (text: string) =>
  text
    .trim()
    .replace(/^(?:["“”'‘’]|\.{3}|…)+\s*/, "")
    .replace(/\s*(?:["“”'‘’]|\.{3}|…)+$/, "")
    .trim();

export function verbatimQuote(quote: string, sources: readonly string[], max: number): string {
  const stripped = foldWithMap(stripQuoteMarks(quote)).folded.trim();
  const bare = stripped.replace(/[\s.,;:!?]+$/, "");
  if (bare.replace(/\s/g, "").length < 3) return "";
  for (const wanted of new Set([foldWithMap(quote).folded.trim(), stripped, bare])) {
    for (const source of sources) {
      const { folded, map } = foldWithMap(source);
      const at = folded.indexOf(wanted);
      if (at === -1) continue;
      const exact = source.slice(map[at], map[at + wanted.length - 1] + 1);
      return exact.includes("%") ? "" : leadingWords(exact, max);
    }
  }
  return "";
}

export function leadingWords(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max + 1);
  const space = cut.search(/\s\S*$/);
  return (space > 0 ? cut.slice(0, space) : trimmed.slice(0, max)).trimEnd();
}

export function referenceExcerpt(extract: string, max = MAX_REFERENCE_EXCERPT): string {
  const percent = extract.indexOf("%");
  const usable = percent === -1 ? extract : extract.slice(0, Math.max(0, extract.lastIndexOf(". ", percent) + 1));
  return leadingWords(usable, max);
}

function storyRefs(refs: readonly string[], plan: ShotPlan): string[] {
  const valid = new Set<string>();
  for (const ref of refs) {
    const match = /^S(\d{1,3})(?:[_ -]?SH(\d{1,3}))?$/i.exec(ref.trim());
    if (!match) continue;
    const sceneIndex = Number(match[1]) - 1;
    const scene = plan.scenes[sceneIndex];
    if (!scene) continue;
    if (match[2] === undefined) {
      valid.add(sceneId(sceneIndex));
      continue;
    }
    const shotIndex = Number(match[2]) - 1;
    if (scene.shots[shotIndex]) valid.add(shotId(sceneIndex, shotIndex));
  }
  return [...valid].slice(0, MAX_STORY_REFS);
}

type FindingContext = { plan: ShotPlan; planTexts: readonly string[] };

const tidy = (text: string, max: number, hide: readonly string[]) =>
  clip(withoutWorkNames(carefulWording(withoutScores(text)), hide), max);

function cleanFinding(
  raw: ModelFinding,
  context: FindingContext,
  hide: readonly string[],
  reference: { id: string; evidence: string } | null,
): DraftFinding | null {
  const title = tidy(raw.title, 160, hide);
  const explanation = tidy(raw.explanation, 1_200, hide);
  if (!title || !explanation) return null;
  return {
    dimension: raw.dimension,
    kind: raw.kind,
    severity: raw.kind === "broad_theme" ? "low" : raw.severity,
    title,
    explanation,
    storyRefs: storyRefs(raw.storyRefs, context.plan),
    storyExcerpt: verbatimQuote(raw.storyExcerpt, context.planTexts, 300),
    suggestion: tidy(raw.suggestion, 800, hide) || DEFAULT_SUGGESTION,
    basis: reference ? "reference" : "ai_review",
    referenceId: reference?.id ?? null,
    referenceEvidence: reference?.evidence ?? "",
  };
}

function cleanTropes(tropes: OriginalityReviewOutput["tropes"], hide: readonly string[]): Trope[] {
  const seen = new Set<string>();
  const clean: Trope[] = [];
  for (const trope of tropes) {
    const title = tidy(trope.title, 120, hide);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    clean.push({ title, note: tidy(trope.note, 400, hide) });
    if (clean.length === MAX_TROPES) break;
  }
  return clean;
}

const TITLE_NOISE = new Set(["potential", "similarity", "similar", "may", "resemble", "resembles", "the", "and", "with", "a", "an", "of", "to", "in"]);

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word && !TITLE_NOISE.has(word)),
  );
}

function sameConcern(a: string, b: string): boolean {
  const left = titleWords(a);
  const right = titleWords(b);
  if (!left.size || !right.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const shared = [...left].filter((word) => right.has(word)).length;
  return (2 * shared) / (left.size + right.size) >= DUPLICATE_TITLE_SIMILARITY;
}

export function mergeFindings(
  drafts: readonly DraftFinding[],
  coverage: Coverage,
  dismissed: readonly string[],
): OriginalityFinding[] {
  const skip = new Set(dismissed.map((key) => key.trim().toLowerCase()));
  const ranked = drafts
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => coverage[finding.dimension] === "checked" && !skip.has(dismissKey(finding)))
    .sort((a, b) => SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] || a.index - b.index);
  const kept: DraftFinding[] = [];
  for (const { finding } of ranked) {
    if (kept.some((other) => other.dimension === finding.dimension && sameConcern(other.title, finding.title))) continue;
    kept.push(finding);
    if (kept.length === MAX_FINDINGS) break;
  }
  return kept.map((finding, index) => ({ id: `F${String(index + 1).padStart(2, "0")}`, ...finding }));
}

async function review(
  callModel: CallModel,
  request: OriginalityRequest,
  options: OriginalityOptions,
): Promise<{ output: OriginalityReviewOutput; usage: UsageRecord }> {
  const timeoutMs = options.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS;
  const signal = deadline(options.signal, timeoutMs);
  const { output, usage } = await untilAborted(
    callModel({
      step: "originality",
      stage: "originality_review",
      instructions: composeInstructions("originality_review", DEFAULT_FORMAT),
      input: reviewInput(request),
      schema: originalityReviewOutput,
      maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
      signal,
      timeoutMs,
    }),
    signal,
  );
  const parsed = originalityReviewOutput.safeParse(output);
  if (!parsed.success) throw new ModelOutputError("Invalid originality review", usage, "invalid_output");
  return { output: parsed.data, usage };
}

type SentReference = { reference: ReferenceWork; extract: string; names: string[] };

export function referencesSection(references: readonly SentReference[]): string {
  return section(
    SECTION.references,
    references.flatMap(({ reference, extract }) => [
      `${reference.id}: ${oneLine(reference.title)}${reference.description ? ` — ${oneLine(reference.description)}` : ""}`,
      fenced(extract),
    ]),
  );
}

async function compare(
  callModel: CallModel,
  request: OriginalityRequest,
  references: readonly SentReference[],
  options: OriginalityOptions,
): Promise<{ output: OriginalityCompareOutput; usage: UsageRecord }> {
  const timeoutMs = options.compareTimeoutMs ?? COMPARE_TIMEOUT_MS;
  const signal = deadline(options.signal, timeoutMs);
  const { output, usage } = await untilAborted(
    callModel({
      step: "originality",
      stage: "originality_compare",
      instructions: composeInstructions("originality_compare", DEFAULT_FORMAT),
      input: sections(planSection(request.plan, request.title), referencesSection(references)),
      schema: originalityCompareOutput,
      maxOutputTokens: COMPARE_MAX_OUTPUT_TOKENS,
      signal,
      timeoutMs,
    }),
    signal,
  );
  const parsed = originalityCompareOutput.safeParse(output);
  if (!parsed.success) throw new ModelOutputError("Invalid originality comparison", usage, "invalid_output");
  return { output: parsed.data, usage };
}

function uniqueCandidates(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates
    .filter(({ title }) => {
      const key = oneLine(title).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_REFERENCES);
}

type Lookups = { results: WorkLookup[]; verified: { work: WikipediaWork; candidate: Candidate }[] };

async function lookUp(candidates: readonly Candidate[], deps: OriginalityDeps, options: OriginalityOptions): Promise<Lookups> {
  const results = await Promise.all(
    candidates.map((candidate) =>
      lookupWork(
        { title: candidate.title, year: candidate.year === null ? null : Math.round(candidate.year), medium: candidate.medium },
        { fetch: deps.fetch, signal: options.signal, timeoutMs: options.lookupTimeoutMs },
      ),
    ),
  );
  const seen = new Set<string>();
  const verified: Lookups["verified"] = [];
  results.forEach(({ work }, index) => {
    if (!work || seen.has(work.url)) return;
    seen.add(work.url);
    verified.push({ work, candidate: candidates[index] });
  });
  return { results, verified };
}

function toReference({ work, candidate }: Lookups["verified"][number], index: number, retrievedAt: string): SentReference {
  const reference: ReferenceWork = {
    id: `R${index + 1}`,
    title: clip(work.title, 200),
    description: clip(withoutScores(work.description), 300),
    url: work.url,
    source: "wikipedia",
    excerpt: referenceExcerpt(work.extract),
    retrievedAt,
  };
  return { reference, extract: leadingWords(work.extract, MAX_COMPARE_EXTRACT), names: workNames([work.title, candidate.title]) };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function lookupStatus(
  requested: boolean,
  results: readonly WorkLookup[],
  verified: number,
  comparison: "compared" | "failed" | "none",
): ReferenceLookup {
  if (!requested) {
    return { requested, status: "not_requested", checked: 0, verified: 0, note: "The Wikipedia reference check was off, so this is the AI review only." };
  }
  const checked = results.length;
  const failed = results.filter(({ failure }) => failure).length;
  const base = { requested, checked, verified };
  if (!checked) {
    return { ...base, status: "ok", note: "The AI review found no existing works worth looking up on Wikipedia." };
  }
  if (failed === checked) {
    return { ...base, status: "unavailable", note: "Wikipedia couldn’t be reached, so this is the AI review only. Try the reference check again later." };
  }
  const looked = `Looked up ${plural(checked, "possible match", "possible matches")} on Wikipedia`;
  if (comparison === "failed") {
    return { ...base, status: "partial", note: `${looked} and found ${plural(verified, "real work", "real works")}, but couldn’t compare them this time, so this is the AI review only.` };
  }
  const outcome = verified
    ? `${plural(verified, "was a real work", "were real works")} and ${verified === 1 ? "was" : "were"} compared with your story`
    : "none could be confirmed as a real work, so no references are shown";
  if (failed) {
    return { ...base, status: "partial", note: `${looked}; ${failed} couldn’t be reached. Of the rest, ${outcome}.` };
  }
  return { ...base, status: "ok", note: `${looked}: ${outcome}.` };
}

function referenceFindings(
  output: OriginalityCompareOutput,
  sent: readonly SentReference[],
  context: FindingContext,
  allNames: readonly string[],
): { findings: DraftFinding[]; dropped: number; blanked: number } {
  const byId = new Map(sent.map((entry) => [entry.reference.id, entry]));
  const findings: DraftFinding[] = [];
  let dropped = 0;
  let blanked = 0;
  for (const raw of output.findings) {
    const entry = byId.get(raw.referenceId.trim().toUpperCase());
    if (!entry) {
      dropped += 1;
      continue;
    }
    const evidence = verbatimQuote(raw.referenceEvidence, [entry.extract], MAX_REFERENCE_EXCERPT);
    if (raw.referenceEvidence.trim() && !evidence) blanked += 1;
    const own = new Set(entry.names);
    const finding = cleanFinding(raw, context, allNames.filter((name) => !own.has(name)), { id: entry.reference.id, evidence });
    if (finding) findings.push(finding);
    else dropped += 1;
  }
  return { findings, dropped, blanked };
}

export async function runOriginality(
  request: OriginalityRequest,
  deps: OriginalityDeps,
  options: OriginalityOptions = {},
): Promise<OriginalityResult> {
  const started = Date.now();
  const { plan } = request;
  const coverage = originalityCoverage(plan);
  const context: FindingContext = { plan, planTexts: planStrings(plan) };

  const reviewed = await review(deps.callModel, request, options);
  const usage: UsageRecord[] = [reviewed.usage];
  const candidates = uniqueCandidates(reviewed.output.candidates);

  const lookups: Lookups = request.references ? await lookUp(candidates, deps, options) : { results: [], verified: [] };
  for (const { requests } of lookups.results) usage.push(...Array.from({ length: requests }, () => ({ ...LOOKUP_USAGE })));
  for (const { failure } of lookups.results) if (failure) console.warn("Wikipedia lookup failed", failure);

  const retrievedAt = (deps.now?.() ?? new Date()).toISOString();
  const sent = lookups.verified.map((entry, index) => toReference(entry, index, retrievedAt));
  const allNames = workNames([...candidates.map(({ title }) => title), ...sent.flatMap(({ names }) => names)]);

  let comparison: "compared" | "failed" | "none" = "none";
  let fromReferences: ReturnType<typeof referenceFindings> = { findings: [], dropped: 0, blanked: 0 };
  if (sent.length) {
    try {
      const compared = await compare(deps.callModel, request, sent, options);
      usage.push(compared.usage);
      fromReferences = referenceFindings(compared.output, sent, context, allNames);
      comparison = "compared";
    } catch (error) {
      if (error instanceof ModelOutputError) usage.push(error.usage);
      console.warn("Originality comparison failed", { ...modelErrorMetadata(error), references: sent.length });
      comparison = "failed";
    }
  }

  const fromReview = reviewed.output.findings
    .map((raw) => cleanFinding(raw, context, allNames, null))
    .filter((finding): finding is DraftFinding => finding !== null);
  const findings = mergeFindings([...fromReferences.findings, ...fromReview], coverage, request.dismissed ?? []);
  const compared = comparison === "compared";

  const report = originalityCheckSchema.parse({
    version: 1,
    mode: compared ? "ai_review_with_references" : "ai_review",
    referenceLookup: lookupStatus(request.references, lookups.results, sent.length, comparison),
    coverage,
    status: findings.some(({ severity }) => severity !== "low") ? "potential_similarities" : "no_significant_concerns",
    tropes: cleanTropes(reviewed.output.tropes, allNames),
    findings,
    references: compared ? sent.map(({ reference }) => reference) : [],
  } satisfies OriginalityCheck);

  console.info("Originality check", {
    ms: Date.now() - started,
    mode: report.mode,
    status: report.status,
    findings: findings.length,
    tropes: report.tropes.length,
    candidates: candidates.length,
    lookupStatus: report.referenceLookup.status,
    lookupRequests: usage.filter(({ step }) => step === "originality-lookup").length,
    verified: sent.length,
    droppedReferenceFindings: fromReferences.dropped,
    blankedEvidence: fromReferences.blanked,
  });
  return { report, usage };
}

