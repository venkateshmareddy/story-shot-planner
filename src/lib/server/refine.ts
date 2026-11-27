import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { DEFAULT_FORMAT } from "@/lib/formats";
import { STORY_MODEL } from "@/lib/models";
import { composeInstructions } from "@/lib/server/prompts";
import { type RefineRequest, refineOutput, type ShotPlan } from "@/lib/story-planning";
import { toUsageRecord, type UsageRecord } from "@/lib/usage";

export type RefineResult = { reply: string; changeSummary: string[]; plan: ShotPlan; usage: UsageRecord };

export class InvalidRefinedPlanError extends Error {
  constructor() {
    super("The refined plan contained an invalid shot");
    this.name = "InvalidRefinedPlanError";
  }
}

export const INVALID_REFINED_PLAN_MESSAGE = "The agent returned an invalid shot. Try rephrasing your request.";

export async function runRefine(client: OpenAI, input: RefineRequest): Promise<RefineResult> {
  const response = await client.responses.parse({
    model: STORY_MODEL,
    store: false,
    instructions: composeInstructions("refine", input.format ?? DEFAULT_FORMAT),
    input: JSON.stringify(input),
    max_output_tokens: 10_000,
    text: { format: zodTextFormat(refineOutput, "refine") },
  });
  const model = response.model || STORY_MODEL;
  const usage = toUsageRecord("refine", model, response.usage);
  console.info("Model usage", { step: "refine", model, usage });
  if (response.status !== "completed" || !response.output_parsed) throw new Error("Incomplete model result");

  const { reply, changeSummary, plan } = response.output_parsed;
  if (
    !plan.scenes.length ||
    plan.scenes.some(
      (scene) =>
        !scene.shots.length ||
        scene.shots.some((shot) => !Number.isFinite(shot.seconds) || shot.seconds <= 0),
    )
  ) {
    throw new InvalidRefinedPlanError();
  }
  return { reply, changeSummary, plan, usage };
}
