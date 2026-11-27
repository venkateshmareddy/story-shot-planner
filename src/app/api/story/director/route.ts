import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { type CallModel, DirectorError, ModelOutputError, runDirector } from "@/lib/agents/orchestrator";
import { directorRequest } from "@/lib/agents/schemas";
import type { DirectorResponse } from "@/lib/agents/types";
import { getOpenAI, jsonError, modelError, STORY_MODEL } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { INVALID_REFINED_PLAN_MESSAGE, InvalidRefinedPlanError, runRefine } from "@/lib/server/refine";
import { toUsageRecord } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 100;

const ACCOUNT_ERROR_STATUSES = new Set([401, 403, 404, 429]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, 1_000_000);
    if (!bytes) return jsonError("This request is too large.", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = directorRequest.safeParse(body);
  if (!parsed.success) return jsonError("Provide a plan and a valid message for the creative team.", 400);

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to use AI planning.", 503);

  const callModel: CallModel = async ({ step, instructions, input, schema, maxOutputTokens, signal }) => {
    const response = await client.responses.parse(
      {
        model: STORY_MODEL,
        store: false,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        text: { format: zodTextFormat(schema, step) },
      },
      { signal },
    );
    const usage = toUsageRecord(step, STORY_MODEL, response.usage);
    console.info("Model usage", { step, model: STORY_MODEL, usage });
    if (response.status !== "completed" || !response.output_parsed) {
      throw new ModelOutputError("Incomplete model result", usage);
    }
    return { output: response.output_parsed, usage };
  };

  try {
    const result: DirectorResponse = await runDirector(
      parsed.data,
      { callModel, refine: (input) => runRefine(client, input) },
      { signal: request.signal },
    );
    console.info("Creative director", {
      mode: result.mode,
      specialists: result.specialists,
      failed: result.failed,
      calls: result.usage.length,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof DirectorError) {
      const accountError = error.causes.find(
        (cause) => cause instanceof OpenAI.APIError && ACCOUNT_ERROR_STATUSES.has(cause.status ?? 0),
      );
      if (accountError) return modelError(accountError, "director");
      console.warn("Creative team failed", { failed: error.failed });
      return jsonError("The creative team couldn’t respond. Try again.", 502);
    }
    if (error instanceof InvalidRefinedPlanError) return jsonError(INVALID_REFINED_PLAN_MESSAGE, 502);
    return modelError(error, "director");
  }
}
