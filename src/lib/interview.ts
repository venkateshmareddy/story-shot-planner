import { z } from "zod";

export const MAX_INTERVIEW_TURNS = 12;

export const collectedItem = z.object({
  label: z.string(),
  detail: z.string(),
});
export type CollectedItem = z.infer<typeof collectedItem>;

export const interviewTurnOutput = z.object({
  note: z.string(),
  complete: z.boolean(),
  question: z.string(),
  rationale: z.string(),
  recommendation: z.string(),
  collected: z.array(collectedItem),
});
export type InterviewTurnOutput = z.infer<typeof interviewTurnOutput>;

export type InterviewExchange = { question: string; answer: string };

export type ResolvedInterviewTurn =
  | { status: "ask"; note: string; question: string; rationale: string; collected: CollectedItem[] }
  | { status: "complete"; note: string; recommendation: string; collected: CollectedItem[] };

function normalizeQuestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const DEFAULT_RECOMMENDATION = "Enough is gathered to plan the shots — continue to story planning.";

export function resolveInterviewTurn(
  output: InterviewTurnOutput,
  answered: InterviewExchange[],
  maxTurns: number = MAX_INTERVIEW_TURNS,
): ResolvedInterviewTurn {
  const question = output.question.trim();
  const askedBefore = new Set(answered.map((exchange) => normalizeQuestion(exchange.question)));
  const isDuplicate = question.length > 0 && askedBefore.has(normalizeQuestion(question));
  const capReached = answered.length >= maxTurns;

  if (output.complete || question.length === 0 || isDuplicate || capReached) {
    return {
      status: "complete",
      note: output.note,
      recommendation: output.recommendation.trim() || DEFAULT_RECOMMENDATION,
      collected: output.collected,
    };
  }

  return {
    status: "ask",
    note: output.note,
    question,
    rationale: output.rationale,
    collected: output.collected,
  };
}
