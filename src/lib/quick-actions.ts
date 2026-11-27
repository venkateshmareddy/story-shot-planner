import type { SpecialistId } from "@/lib/agents/types";
import { DECIDE_ANSWER, type DiscoveryCommand, SKIPPED_ANSWER } from "@/lib/story-context";

export type QuickAction = {
  label: string;
  message: string;
  /** Specialists the router should pick for `message`; kept in sync by test/quick-actions.test.ts. */
  specialists: readonly SpecialistId[] | "all";
};

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "Story check",
    message: "Check the story structure, the characters and the conflict.",
    specialists: ["story-analyst"],
  },
  {
    label: "Camera ideas",
    message: "Suggest camera angles, lenses, framing and lighting for each shot.",
    specialists: ["cinematography-director"],
  },
  {
    label: "Sound design",
    message: "Plan the sound: music, ambience, Foley and silence for each scene.",
    specialists: ["sound-director"],
  },
  {
    label: "Editing & pacing",
    message: "Suggest cuts, transitions, pacing and rhythm for the film.",
    specialists: ["editing-director"],
  },
  {
    label: "Consistency check",
    message: "Check continuity of the cast, props, costumes, locations and timeline.",
    specialists: ["continuity-reviewer"],
  },
  {
    label: "Full review",
    message: "Review the whole film and give me your notes.",
    specialists: "all",
  },
];

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
