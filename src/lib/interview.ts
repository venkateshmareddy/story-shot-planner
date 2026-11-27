import { z } from "zod";
import {
  type ContextFact,
  detectDiscoveryCommand,
  mergeFacts,
  type StoryContext,
  toCollected,
  withUnresolved,
} from "./story-context";
import { storyCategorySchema } from "./story-context-schema";

export const MAX_INTERVIEW_TURNS = 12;

export const collectedItem = z.object({
  label: z.string(),
  detail: z.string(),
});
export type CollectedItem = z.infer<typeof collectedItem>;

// No length constraints here: strict structured outputs reject them; values are clipped in resolveInterviewTurn.
export const interviewFact = z.object({
  category: storyCategorySchema,
  label: z.string(),
  value: z.string(),
  source: z.enum(["user", "ai"]),
});

export const interviewTurnOutput = z.object({
  note: z.string(),
  complete: z.boolean(),
  question: z.string(),
  rationale: z.string(),
  recommendation: z.string(),
  facts: z.array(interviewFact),
  unresolved: z.array(z.string()),
});
export type InterviewTurnOutput = z.infer<typeof interviewTurnOutput>;

export type InterviewExchange = { question: string; answer: string };

type TurnState = { note: string; context: StoryContext; collected: CollectedItem[] };

export type ResolvedInterviewTurn =
  | ({ status: "ask"; question: string; rationale: string } & TurnState)
  | ({ status: "complete"; recommendation: string } & TurnState);

function normalizeQuestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const DEFAULT_RECOMMENDATION = "Enough is gathered to plan the shots — continue to story planning.";
export const STOP_RECOMMENDATION = "Creating your plan now.";

// Mirrors storyContextSchema limits so the returned context is accepted when the client sends it back.
const clip = (text: string, max: number) => text.trim().slice(0, max);

/** The filmmaker's latest answer is a whole-message stop command ("stop", "proceed", "generate plan"…). */
export function isStopRequest(answered: InterviewExchange[]): boolean {
  const last = answered.at(-1);
  return last !== undefined && detectDiscoveryCommand(last.answer) === "stop";
}

/** Deterministic completion for a stop command — no model call, context unchanged. */
export function stopTurn(context: StoryContext): ResolvedInterviewTurn {
  return { status: "complete", note: "", recommendation: STOP_RECOMMENDATION, context, collected: toCollected(context) };
}

export function resolveInterviewTurn(
  output: InterviewTurnOutput,
  answered: InterviewExchange[],
  context: StoryContext,
  maxTurns: number = MAX_INTERVIEW_TURNS,
): ResolvedInterviewTurn {
  const updates: ContextFact[] = output.facts.map((fact) => ({
    category: fact.category,
    label: clip(fact.label, 80),
    value: clip(fact.value, 600),
    source: fact.source,
    approved: fact.source === "user",
  }));
  const merged = withUnresolved(
    mergeFacts(context, updates),
    output.unresolved.map((item) => clip(item, 300)),
  );
  const state = { note: output.note, context: merged, collected: toCollected(merged) };

  const question = output.question.trim();
  const askedBefore = new Set(answered.map((exchange) => normalizeQuestion(exchange.question)));
  const isDuplicate = question.length > 0 && askedBefore.has(normalizeQuestion(question));
  const capReached = answered.length >= maxTurns;

  if (output.complete || question.length === 0 || isDuplicate || capReached) {
    return { status: "complete", recommendation: output.recommendation.trim() || DEFAULT_RECOMMENDATION, ...state };
  }

  return { status: "ask", question, rationale: output.rationale, ...state };
}
