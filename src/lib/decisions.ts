import type { DecisionRecord } from "@/lib/agents/types";
import type { ChatMessage } from "@/lib/session";
import { MAX_DECISIONS } from "@/lib/story-planning";

// Mirror the decisionRecord schema limits in story-planning.ts.
export const MAX_DECISION_REQUEST = 300;
export const MAX_DECISION_CHANGES = 8;
export const MAX_DECISION_CHANGE = 200;

function clip(text: string, max: number): string {
  return text.trim().slice(0, max).trimEnd();
}

/** Applied and discarded proposals paired with the request that produced them, oldest first, capped at MAX_DECISIONS. */
export function buildDecisionHistory(messages: readonly ChatMessage[]): DecisionRecord[] {
  const decisions: DecisionRecord[] = [];
  let lastRequest = "";
  for (const message of messages) {
    if (message.role === "user") {
      lastRequest = message.text;
      continue;
    }
    if (message.status !== "accepted" && message.status !== "rejected") continue;
    decisions.push({
      status: message.status,
      request: clip(lastRequest, MAX_DECISION_REQUEST),
      changes: (message.changeSummary ?? [])
        .map((change) => clip(change, MAX_DECISION_CHANGE))
        .filter((change) => change.length > 0)
        .slice(0, MAX_DECISION_CHANGES),
    });
  }
  return decisions.slice(-MAX_DECISIONS);
}
