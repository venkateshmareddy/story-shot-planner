import OpenAI from "openai";
import { DirectorError, directorFailureMessage, runDirector } from "@/lib/agents/orchestrator";
import { directorRequest } from "@/lib/agents/schemas";
import type { DirectorResponse } from "@/lib/agents/types";
import { createModelCaller, getOpenAI, jsonError, modelError } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { INVALID_REFINED_PLAN_MESSAGE, InvalidRefinedPlanError, runRefine } from "@/lib/server/refine";

export const runtime = "nodejs";
// Worst case is a plan edit: decision (60 s) then parallel scene rewrites (100 s); specialists (90 s) + synthesis (30 s) is shorter.
export const maxDuration = 180;

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

  const callModel = createModelCaller(client);

  try {
    const result: DirectorResponse = await runDirector(
      parsed.data,
      {
        callModel,
        refine: (input) =>
          runRefine(callModel, input, {
            signal: request.signal,
            onFailure: (failure) => console.warn("Plan edit call failed", failure),
          }),
      },
      { signal: request.signal, onSpecialistFailure: (failure) => console.warn("Specialist failed", failure) },
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
      return jsonError(directorFailureMessage(error.failed), 502);
    }
    if (error instanceof InvalidRefinedPlanError) {
      console.warn("Plan edit rejected", { reason: error.reason });
      return jsonError(INVALID_REFINED_PLAN_MESSAGE, 502);
    }
    return modelError(error, "director");
  }
}
