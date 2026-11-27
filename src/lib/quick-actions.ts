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
    message:
      "Check that the story is easy to follow and that the characters and their main problem are clear. Just the most important fixes.",
    specialists: ["story-analyst"],
  },
  {
    label: "Camera ideas",
    message:
      "Suggest camera ideas for the few shots that matter most: where to put the camera, how close to get and how to light them.",
    specialists: ["cinematography-director"],
  },
  {
    label: "Sound design",
    message:
      "Suggest sound for the scenes that matter most: music, background sounds, everyday noises like footsteps, and when to go quiet.",
    specialists: ["sound-director"],
  },
  {
    label: "Editing & pacing",
    message:
      "Check the timing of the film: where to cut, how to go from one scene to the next, and which parts feel too slow or rushed. Just the biggest fixes.",
    specialists: ["editing-director"],
  },
  {
    label: "Consistency check",
    message:
      "Check for mistakes between scenes: do people, clothes, props and places stay the same, and do events happen in the right order? List the biggest ones.",
    specialists: ["continuity-reviewer"],
  },
  {
    label: "Full review",
    message: "Review the whole film and give me your most important notes.",
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
