import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { DEFAULT_FORMAT } from "@/lib/formats";
import { composeInstructions } from "@/lib/server/prompts";
import { getOpenAI, jsonError, modelError, STORY_MODEL } from "@/lib/server/openai";
import { findPlanProblem } from "@/lib/server/plan-validation";
import { readBody } from "@/lib/server/read-body";
import { isStopRequest, MAX_INTERVIEW_TURNS, interviewTurnOutput, resolveInterviewTurn, stopTurn } from "@/lib/interview";
import { hasStorySource } from "@/lib/source-text";
import { EMPTY_CONTEXT, missingCategories } from "@/lib/story-context";
import { draftOutput, planOutput, planningRequest } from "@/lib/story-planning";
import { toUsageRecord } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 100;

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, 512_000);
    if (!bytes) return jsonError("This request is too large.", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = planningRequest.safeParse(body);
  if (!parsed.success) return jsonError("Provide a story and valid inputs for this step.", 400);

  const input = parsed.data;
  if (input.step === "interview" && isStopRequest(input.answered ?? [])) {
    return Response.json(stopTurn(input.context ?? EMPTY_CONTEXT));
  }

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to use AI planning.", 503);

  const format = input.format ?? DEFAULT_FORMAT;
  const generate = async <T extends z.ZodType>(schema: T, maxOutputTokens: number, payload: unknown = input) => {
    const response = await client.responses.parse({
      model: STORY_MODEL,
      store: false,
      instructions: composeInstructions(input.step, format),
      input: JSON.stringify(payload),
      max_output_tokens: maxOutputTokens,
      text: { format: zodTextFormat(schema, input.step) },
    });
    const model = response.model || STORY_MODEL;
    const usage = toUsageRecord(input.step, model, response.usage);
    console.info("Model usage", { step: input.step, model, usage });
    if (response.status !== "completed" || !response.output_parsed) throw new Error("Incomplete model result");
    return { output: response.output_parsed, usage };
  };

  try {
    if (input.step === "draft") {
      const { output: draft, usage } = await generate(draftOutput, 3_000);
      if (!planningRequest.safeParse({ step: "interview", story: draft.story }).success) {
        throw new Error("Invalid story draft");
      }
      return Response.json({ ...draft, usage });
    }
    if (input.step === "interview") {
      const context = input.context ?? EMPTY_CONTEXT;
      const missing = missingCategories(context).map((category) => category.id);
      const { output, usage } = await generate(interviewTurnOutput, 2_000, { ...input, context, missing });
      const resolved = resolveInterviewTurn(output, input.answered ?? [], context, MAX_INTERVIEW_TURNS, {
        titleOnly: !hasStorySource(input.story),
      });
      return Response.json({ ...resolved, usage });
    }

    const { output: plan, usage } = await generate(planOutput, 8_000);
    const problem = findPlanProblem(plan);
    if (problem) {
      console.warn("Rejected model plan", { step: input.step, problem });
      return jsonError("The draft contained an invalid scene, shot or dialogue entry. Try again.", 502);
    }
    return Response.json({ ...plan, usage });
  } catch (error) {
    return modelError(error, input.step);
  }
}
