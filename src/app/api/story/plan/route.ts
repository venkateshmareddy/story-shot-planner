import type { z } from "zod";
import { DEFAULT_FORMAT } from "@/lib/formats";
import { isStopRequest, MAX_INTERVIEW_TURNS, interviewTurnOutput, resolveInterviewTurn, stopTurn } from "@/lib/interview";
import { createModelCaller, getOpenAI, jsonError, ModelOutputError, modelError } from "@/lib/server/openai";
import { PlanGenerationError, runPlan } from "@/lib/server/plan-generation";
import { composeInstructions } from "@/lib/server/prompts";
import { readBody } from "@/lib/server/read-body";
import { hasStorySource } from "@/lib/source-text";
import { EMPTY_CONTEXT, missingCategories } from "@/lib/story-context";
import { draftOutput, planningRequest } from "@/lib/story-planning";

export const runtime = "nodejs";
export const maxDuration = 180;

const PLAN_FAILURE_MESSAGES = {
  outline: "The scene outline came back unusable. Try again.",
  scene: "One scene came back without shots. Try again.",
  invalid_plan: "The draft contained an invalid scene, shot or dialogue entry. Try again.",
} as const;

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
  if (!parsed.success) {
    console.warn("Rejected story request", {
      issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
    return jsonError("Provide a story and valid inputs for this step.", 400);
  }

  const input = parsed.data;
  if (input.step === "interview" && isStopRequest(input.answered ?? [])) {
    return Response.json(stopTurn(input.context ?? EMPTY_CONTEXT));
  }

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to use AI planning.", 503);

  const format = input.format ?? DEFAULT_FORMAT;
  const callModel = createModelCaller(client);
  const generate = async <T extends z.ZodType>(
    step: "draft" | "interview",
    schema: T,
    maxOutputTokens: number,
    payload: unknown = input,
  ) => {
    const { output, usage } = await callModel({
      step,
      instructions: composeInstructions(step, format),
      input: JSON.stringify(payload),
      schema,
      maxOutputTokens,
      signal: request.signal,
    });
    const result = schema.safeParse(output);
    if (!result.success) throw new ModelOutputError("Invalid model result", usage);
    return { output: result.data, usage };
  };

  try {
    if (input.step === "draft") {
      const { output: draft, usage } = await generate("draft", draftOutput, 3_000);
      if (!planningRequest.safeParse({ step: "interview", story: draft.story }).success) {
        throw new Error("Invalid story draft");
      }
      return Response.json({ ...draft, usage });
    }
    if (input.step === "interview") {
      const context = input.context ?? EMPTY_CONTEXT;
      const missing = missingCategories(context).map((category) => category.id);
      const { output, usage } = await generate("interview", interviewTurnOutput, 2_000, { ...input, context, missing });
      const resolved = resolveInterviewTurn(output, input.answered ?? [], context, MAX_INTERVIEW_TURNS, {
        titleOnly: !hasStorySource(input.story),
      });
      return Response.json({ ...resolved, usage });
    }

    const { plan, usage } = await runPlan(input, callModel, { signal: request.signal });
    return Response.json({ ...plan, usage });
  } catch (error) {
    if (error instanceof PlanGenerationError) {
      console.warn("Rejected model plan", { step: input.step, failure: error.failure, problem: error.detail });
      return jsonError(PLAN_FAILURE_MESSAGES[error.failure], 502);
    }
    return modelError(error, input.step);
  }
}
