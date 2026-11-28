// Story originality review — shared contract (client-safe). An AI review always runs; a reference check against
// Wikipedia is optional and only ever cites pages the server actually fetched.
import { z } from "zod";
import { storyContextSchema } from "./story-context-schema";
import { planOutput } from "./story-planning";

export const ORIGINALITY_DIMENSIONS = ["plot", "characters", "scenes", "dialogue", "structure"] as const;
export type OriginalityDimension = (typeof ORIGINALITY_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<OriginalityDimension, string> = {
  plot: "Plot and premise",
  characters: "Characters and relationships",
  scenes: "Scenes and sequences",
  dialogue: "Dialogue and phrases",
  structure: "Story structure",
};

export const SEVERITIES = ["low", "moderate", "high"] as const;
export type OriginalitySeverity = (typeof SEVERITIES)[number];

export const SEVERITY_DEFINITIONS: Record<OriginalitySeverity, string> = {
  low: "Shares broad themes or genre conventions with other works. Usually fine; worth a look only if you want it fresher.",
  moderate: "A specific combination of characters, events or sequence may resemble an existing work. Consider making it more distinctive.",
  high: "Distinctive expression — a specific line, named sequence or unusual plot mechanism — may closely resemble an existing work. Revise before sharing the film.",
};

/** broad_theme findings are always low; common tropes are never findings (they go in `tropes`). */
export const FINDING_KINDS = ["broad_theme", "similar_combination", "distinctive_expression"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** ai_review = the AI's judgement; reference = backed by a fetched, verified reference page. */
export const FINDING_BASES = ["ai_review", "reference"] as const;

export const MAX_FINDINGS = 12;
export const MAX_TROPES = 6;
export const MAX_REFERENCES = 5;
export const MAX_DISMISSED = 40;
export const MAX_REFERENCE_EXCERPT = 300;
export const REFERENCE_SOURCES = ["wikipedia"] as const;

const text = (max: number) => z.string().trim().max(max);

export const referenceWorkSchema = z.object({
  id: text(80).min(1),
  title: text(200).min(1),
  /** Wikipedia's own short description, e.g. "2000 film by Robert Zemeckis". */
  description: text(300),
  url: z.string().url().max(500),
  source: z.enum(REFERENCE_SOURCES),
  /** A short excerpt of the fetched summary, quoted verbatim (≤ MAX_REFERENCE_EXCERPT), with attribution. */
  excerpt: text(MAX_REFERENCE_EXCERPT),
  /** ISO 8601 time the page was fetched. */
  retrievedAt: z.string().datetime(),
});
export type ReferenceWork = z.infer<typeof referenceWorkSchema>;

export const originalityFindingSchema = z.object({
  /** Stable within a report; dismissal uses `dismissKey(finding)`, which survives re-checks. */
  id: text(80).min(1),
  dimension: z.enum(ORIGINALITY_DIMENSIONS),
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(SEVERITIES),
  title: text(160).min(1),
  explanation: text(1_200).min(1),
  /** Scenes/shots of the filmmaker's plan this is about, e.g. "S02" or "S03_SH04". */
  storyRefs: z.array(text(16)).max(12),
  /** A short excerpt of the filmmaker's own plan text. */
  storyExcerpt: text(300),
  suggestion: text(800).min(1),
  basis: z.enum(FINDING_BASES),
  /** Set only when basis is "reference", and then it must match a report reference id. */
  referenceId: text(80).nullable(),
  /** Verbatim words from that reference's fetched summary; "" when none. */
  referenceEvidence: text(MAX_REFERENCE_EXCERPT),
});
export type OriginalityFinding = z.infer<typeof originalityFindingSchema>;

export const referenceLookupSchema = z.object({
  requested: z.boolean(),
  status: z.enum(["not_requested", "ok", "partial", "unavailable"]),
  /** Candidate works looked up / pages verified as real creative works. */
  checked: z.number().int().min(0).max(MAX_REFERENCES),
  verified: z.number().int().min(0).max(MAX_REFERENCES),
  note: text(300),
});

export const originalityReportSchema = z.object({
  version: z.literal(1),
  createdAt: z.number().int().positive(),
  /** "ai_review" unless at least one reference was verified and compared. */
  mode: z.enum(["ai_review", "ai_review_with_references"]),
  referenceLookup: referenceLookupSchema,
  coverage: z.record(z.enum(ORIGINALITY_DIMENSIONS), z.enum(["checked", "not_available"])),
  /** Computed in code: potential_similarities when any open finding is moderate or high. */
  status: z.enum(["no_significant_concerns", "potential_similarities"]),
  tropes: z.array(z.object({ title: text(120).min(1), note: text(400) })).max(MAX_TROPES),
  findings: z.array(originalityFindingSchema).max(MAX_FINDINGS),
  references: z.array(referenceWorkSchema).max(MAX_REFERENCES),
  /** planSignature() of the plan that was checked; differs → the report is out of date. */
  planSignature: text(80),
});
export type OriginalityReport = z.infer<typeof originalityReportSchema>;

/** What a session keeps: the latest report and the findings the filmmaker dismissed (kept across re-checks). */
export const sessionOriginalitySchema = z.object({
  report: originalityReportSchema,
  dismissed: z.array(text(200).min(1)).max(MAX_DISMISSED),
});
export type SessionOriginality = z.infer<typeof sessionOriginalitySchema>;

/** POST /api/story/originality request. One review call, plus one comparison call only when references were verified. */
export const originalityRequestSchema = z.object({
  title: text(200).min(1),
  plan: planOutput,
  context: storyContextSchema.optional(),
  /** The filmmaker's imported story text or digest (already headed by the client), when there is one. */
  source: text(26_000).optional(),
  /** Dismiss keys of findings the filmmaker dismissed; the AI is told not to repeat them. */
  dismissed: z.array(text(200).min(1)).max(MAX_DISMISSED).optional(),
  /** The filmmaker opted in to the Wikipedia reference check (only work titles are sent to Wikipedia). */
  references: z.boolean(),
});
export type OriginalityRequest = z.infer<typeof originalityRequestSchema>;

/** Key that identifies "the same concern" across re-checks: dimension + normalised title. */
export function dismissKey(finding: Pick<OriginalityFinding, "dimension" | "title">): string {
  return `${finding.dimension}:${finding.title.trim().toLowerCase().replace(/\s+/g, " ")}`.slice(0, 200);
}

export const NO_CONCERNS_MESSAGE =
  "No significant similarities were identified within the available analysis and reference sources.";
export const ORIGINALITY_DISCLAIMER =
  "This review is an investigative aid, not a guarantee of originality and not legal advice. Findings are signals to look into, not proof of copying.";
