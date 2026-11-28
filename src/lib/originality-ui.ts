import {
  DIMENSION_LABELS,
  dismissKey,
  NO_CONCERNS_MESSAGE,
  type OriginalityDimension,
  type OriginalityFinding,
  type OriginalityReport,
  type OriginalitySeverity,
  type ReferenceWork,
} from "@/lib/originality";
import { planSignature } from "@/lib/session";
import type { ContextFact, StoryCategoryId, StoryContext } from "@/lib/story-context";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/story-input";
import type { ShotPlan } from "@/lib/story-planning";

export const ORIGINALITY_COPY = {
  panelTitle: "Story originality",
  intro:
    "This check reads your plan and points out parts that may be close to existing films, books or shows. It also lists familiar story ideas that many films share, which are fine to use.",
  introSafe: "Nothing in your story changes. You decide what to do with each finding.",
  referencesLabel: "Also look for similar published works on Wikipedia",
  referencesDisclosure:
    "Only the titles of possibly similar works are sent to Wikipedia, never your story. Your story itself is checked by the same AI service the app already uses.",
  run: "Run check",
  recheck: "Re-check",
  retry: "Try again",
  running: "Checking your story… This can take up to a minute.",
  runningWithReferences: "Checking your story and looking up similar published works… This can take up to a minute.",
  finished: "Check complete. The report is below.",
  close: "Close",
  outOfDate: "Out of date — your story changed since this check",
  overall: "Overall",
  coverageHeading: "What was checked",
  checked: "checked",
  notAvailable: "not available yet",
  tropesHeading: "Common tropes (not a concern)",
  tropesIntro: "Familiar ideas that many films share. They are fine to use.",
  findingsHeading: "Findings",
  legendHeading: "What the levels mean",
  storyParts: "Story parts",
  fromYourStory: "From your story",
  suggestion: "Suggestion",
  aiIdentified: "AI-identified — not matched to a source",
  verifiedSource: "Verified source",
  retrieved: "Retrieved",
  sourceAttribution: "Source: Wikipedia (CC BY-SA)",
  opensInNewTab: "(opens in a new tab)",
  dismiss: "Dismiss",
  undo: "Undo",
  dismissedHint: "Dismissed findings stay hidden and the next check won’t raise them again.",
  confirmChange: "This may change things you decided:",
  confirmQuestion: "Continue?",
  confirmContinue: "Continue",
  cancel: "Cancel",
  statusConcern: "Some parts may be close to existing works. Look at the findings below.",
  statusAllDismissed: "You dismissed every moderate and high finding.",
  noOpenFindings: "No findings to show.",
} as const;

export function dismissedHeading(count: number): string {
  return `Dismissed (${count})`;
}

export function checkedAtLabel(date: string): string {
  return `Checked ${date}`;
}

export function moreLabel(count: number): string {
  return `+${count} more`;
}

export const SEVERITY_ORDER: readonly OriginalitySeverity[] = ["high", "moderate", "low"];
export const SEVERITY_LABELS: Record<OriginalitySeverity, string> = { high: "High", moderate: "Moderate", low: "Low" };

export function modeLabel(report: Pick<OriginalityReport, "mode" | "referenceLookup" | "references">): string {
  if (report.mode !== "ai_review_with_references") return "AI-based originality review";
  const count = report.referenceLookup.verified || report.references.length;
  return `AI review + reference check (${count} verified source${count === 1 ? "" : "s"})`;
}

export type LookupNote = { text: string; warning: boolean };

/** The reference-lookup note, flagged as a warning when some or all Wikipedia lookups failed. */
export function lookupNote(report: Pick<OriginalityReport, "referenceLookup">): LookupNote | null {
  const { requested, status, note } = report.referenceLookup;
  if (!requested || !note.trim()) return null;
  return { text: note.trim(), warning: status === "partial" || status === "unavailable" };
}

export type OverallStatus = { tone: "clear" | "concern" | "dismissed"; text: string };

export function overallStatus(report: OriginalityReport, dismissed: readonly string[]): OverallStatus {
  if (report.status === "no_significant_concerns") return { tone: "clear", text: NO_CONCERNS_MESSAGE };
  const hidden = new Set(dismissed);
  const open = report.findings.some((finding) => finding.severity !== "low" && !hidden.has(dismissKey(finding)));
  return open
    ? { tone: "concern", text: ORIGINALITY_COPY.statusConcern }
    : { tone: "dismissed", text: ORIGINALITY_COPY.statusAllDismissed };
}

export type SeverityGroup = { severity: OriginalitySeverity; findings: OriginalityFinding[] };

/** Open findings grouped High → Moderate → Low (empty groups left out), and the dismissed ones in report order. */
export function splitFindings(
  findings: readonly OriginalityFinding[],
  dismissed: readonly string[],
): { groups: SeverityGroup[]; dismissed: OriginalityFinding[] } {
  const hidden = new Set(dismissed);
  const open = findings.filter((finding) => !hidden.has(dismissKey(finding)));
  return {
    groups: SEVERITY_ORDER.map((severity) => ({
      severity,
      findings: open.filter((finding) => finding.severity === severity),
    })).filter((group) => group.findings.length > 0),
    dismissed: findings.filter((finding) => hidden.has(dismissKey(finding))),
  };
}

export function isReportOutOfDate(plan: ShotPlan | null, report: Pick<OriginalityReport, "planSignature">): boolean {
  return planSignature(plan) !== report.planSignature;
}

/** The verified reference behind a finding; null for AI-identified findings or an unknown reference id. */
export function findingReference(
  finding: Pick<OriginalityFinding, "basis" | "referenceId">,
  references: readonly ReferenceWork[],
): ReferenceWork | null {
  if (finding.basis !== "reference" || !finding.referenceId) return null;
  return references.find((reference) => reference.id === finding.referenceId) ?? null;
}

/** Only https links are rendered; anything else is shown as plain text. */
export function safeSourceUrl(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export const DIMENSION_FACT_CATEGORIES: Record<OriginalityDimension, readonly StoryCategoryId[]> = {
  plot: ["concept", "structure"],
  characters: ["characters", "relationships"],
  scenes: ["scenes", "locations"],
  dialogue: ["dialogue"],
  structure: ["structure"],
};

/** Facts the filmmaker said or approved in the categories a revision of this dimension may touch. */
export function decidedFactsFor(context: StoryContext | undefined, dimension: OriginalityDimension): ContextFact[] {
  const categories: readonly StoryCategoryId[] = DIMENSION_FACT_CATEGORIES[dimension];
  return (context?.facts ?? []).filter(
    (fact) => categories.includes(fact.category) && (fact.approved || fact.source === "user"),
  );
}

export const FINDING_ACTIONS = ["discuss", "alternatives", "revise"] as const;
export type FindingAction = (typeof FINDING_ACTIONS)[number];

export const FINDING_ACTION_LABELS: Record<FindingAction, string> = {
  discuss: "Discuss with Creative Director",
  alternatives: "Suggest alternatives",
  revise: "Apply revision",
};

export const FINDING_ACTION_HINTS: Record<FindingAction, string> = {
  discuss: "Ask the Creative Director about this in the chat. Nothing on your board changes.",
  alternatives: "Ask the Creative Director for 2–3 fresher options in the chat. Nothing on your board changes.",
  revise: "Ask the Creative Director to rewrite only these parts. You’ll see the changes first and choose Apply or Discard.",
};

function partsList(finding: OriginalityFinding): string {
  return finding.storyRefs.map((ref) => ref.trim()).filter(Boolean).join(", ");
}

function describeFinding(finding: OriginalityFinding): string {
  const parts = partsList(finding);
  return [
    `Finding: “${finding.title}”`,
    `Area: ${DIMENSION_LABELS[finding.dimension]} · Level: ${SEVERITY_LABELS[finding.severity]}`,
    `Story parts: ${parts || "not named"}`,
    `What the check found: ${finding.explanation}`,
  ].join("\n");
}

/** The chat message an action sends to the Creative Director; it always names the finding. */
export function findingActionMessage(action: FindingAction, finding: OriginalityFinding): string {
  const parts = partsList(finding);
  let message: string;
  if (action === "discuss") {
    message = [
      "My story’s originality check flagged this. I’d like your view before changing anything.",
      describeFinding(finding),
      "What do you think: does it matter for my film, and what are my options? Don’t change the board yet.",
    ].join("\n\n");
  } else if (action === "alternatives") {
    message = [
      "My story’s originality check flagged this. Suggest 2–3 more distinctive alternatives for this part, in plain words, so I can choose. Don’t change the board yet.",
      describeFinding(finding),
      `The check suggested: ${finding.suggestion}`,
    ].join("\n\n");
  } else {
    // No dimension label or explanation: their keywords would route this to field-limited experts, not the plan edit.
    message = [
      parts
        ? `Revise only these parts: ${parts}. Make them more distinctive by following this suggestion: ${finding.suggestion}`
        : `Revise only the part this finding is about. Make it more distinctive by following this suggestion: ${finding.suggestion}`,
      `Reason: the originality check flagged “${finding.title}” (${SEVERITY_LABELS[finding.severity]} level).`,
      "Keep everything else as it is.",
    ].join("\n\n");
  }
  return message.slice(0, MAX_CHAT_MESSAGE_CHARACTERS);
}
