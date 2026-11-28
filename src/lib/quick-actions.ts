import type { SpecialistId } from "@/lib/agents/types";
import { ENGAGEMENT_ENTRY_LABEL } from "@/lib/engagement";
import type { StorySession } from "@/lib/session";
import { DECIDE_ANSWER, type DiscoveryCommand, SKIPPED_ANSWER } from "@/lib/story-context";

export type QuickAction = {
  label: string;
  message: string;
  /** Specialists the router should pick for `message`; kept in sync by test/quick-actions.test.ts. */
  specialists: readonly SpecialistId[] | "all";
};

export type ExpertAction = QuickAction & { description: string };

export const EXPERT_ACTIONS: readonly ExpertAction[] = [
  {
    label: "Story check",
    description: "Is the story clear?",
    message:
      "Check that the story is easy to follow and that the characters and their main problem are clear. Just the most important fixes.",
    specialists: ["story-analyst"],
  },
  {
    label: "Camera ideas",
    description: "Angles, distance, light",
    message:
      "Suggest camera ideas for the few shots that matter most: where to put the camera, how close to get and how to light them.",
    specialists: ["cinematography-director"],
  },
  {
    label: "Sound design",
    description: "Music, sounds, silence",
    message:
      "Suggest sound for the scenes that matter most: music, background sounds, everyday noises like footsteps, and when to go quiet.",
    specialists: ["sound-director"],
  },
  {
    label: "Editing & pacing",
    description: "Cuts, slow or rushed parts",
    message:
      "Check the timing of the film: where to cut, how to go from one scene to the next, and which parts feel too slow or rushed. Just the biggest fixes.",
    specialists: ["editing-director"],
  },
  {
    label: "Consistency",
    description: "Mistakes between scenes",
    message:
      "Check for mistakes between scenes: do people, clothes, props and places stay the same, and do events happen in the right order? List the biggest ones.",
    specialists: ["continuity-reviewer"],
  },
];

export const FULL_REVIEW_ACTION: QuickAction = {
  label: "Full review",
  message: "Review the whole film and give me your most important notes.",
  specialists: "all",
};

export const QUICK_ACTIONS: readonly QuickAction[] = [...EXPERT_ACTIONS, FULL_REVIEW_ACTION];

export const EXPERT_MENU_LABEL = "Ask an expert";

/** Sits in the expert row but opens the originality report instead of sending a chat message. */
export const ORIGINALITY_ACTION = {
  label: "Check story originality",
  shortLabel: "Originality",
  tooltip:
    "Look for parts of your story that may be close to existing films, books or shows. Nothing in your story changes.",
} as const;

export function showOriginalityAction(session: Pick<StorySession, "phase" | "plan">): boolean {
  return session.phase === "refining" && session.plan !== null;
}

/** Sits next to the originality chip and opens the Audience Retention Predictor report. */
export const ENGAGEMENT_ACTION = {
  label: ENGAGEMENT_ENTRY_LABEL,
  shortLabel: "Retention",
  tooltip: "An AI estimate of how well each scene could hold attention — not real audience data.",
} as const;

export function showEngagementAction(session: Pick<StorySession, "phase" | "plan">): boolean {
  return showOriginalityAction(session);
}

export type ReportId = "originality" | "engagement";
/** `label` is the full name (accessible name and tooltip); `shortLabel` is the visible button text. */
export type ReportAction = { id: ReportId; label: string; shortLabel: string; tooltip: string };

/** Report buttons at the end of the expert row, in display order. Each opens a report panel instead of sending a message. */
export const REPORT_ACTIONS: readonly ReportAction[] = [
  { id: "originality", ...ORIGINALITY_ACTION },
  { id: "engagement", ...ENGAGEMENT_ACTION },
];

export function showReportAction(id: ReportId, session: Pick<StorySession, "phase" | "plan">): boolean {
  return id === "engagement" ? showEngagementAction(session) : showOriginalityAction(session);
}

/** The accessible name leads with the visible label when the full name doesn't contain it (WCAG 2.5.3 label in name). */
export function reportName(action: ReportAction): string {
  return action.label.toLowerCase().includes(action.shortLabel.toLowerCase())
    ? action.label
    : `${action.shortLabel} — ${action.label}`;
}

export function reportTitle(action: ReportAction): string {
  return `${action.label}. ${action.tooltip}`;
}

export type DiscoveryAction = { label: string; command: DiscoveryCommand };

/** Labels are sent as the user's message, so each must be detected as its own command. */
export const DISCOVERY_ACTIONS: readonly DiscoveryAction[] = [
  { label: "You decide", command: "decide" },
  { label: "Skip", command: "skip" },
  { label: "Create plan now", command: "stop" },
];

/** The answer recorded for the pending question: the marker for skip/decide, otherwise the user's words. */
export function answerFor(command: DiscoveryCommand | null, text: string): string {
  if (command === "skip") return SKIPPED_ANSWER;
  if (command === "decide") return DECIDE_ANSWER;
  return text;
}
