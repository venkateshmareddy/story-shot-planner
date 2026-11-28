import { resolveStoryModel } from "@/lib/server/model-catalog";
import { createModelCaller, getOpenAI, jsonError, modelError } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { INVALID_REFINED_PLAN_MESSAGE, InvalidRefinedPlanError, runRefine } from "@/lib/server/refine";
import { refineRequest } from "@/lib/story-planning";
import { sumUsage } from "@/lib/usage";

export const runtime = "nodejs";
// Decision (60 s) then parallel scene rewrites (100 s).
export const maxDuration = 180;

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, 1_000_000);
    if (!bytes) return jsonError("This request is too large.", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = refineRequest.safeParse(body);
  if (!parsed.success) return jsonError("Provide a plan and a valid message for the agent.", 400);

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to use AI planning.", 503);

  try {
    const result = await runRefine(createModelCaller(client, resolveStoryModel(request)), parsed.data, {
      signal: request.signal,
      onFailure: (failure) => console.warn("Plan edit call failed", failure),
    });
    return Response.json({
      reply: result.reply,
      changeSummary: result.changeSummary,
      plan: result.changed ? result.plan : null,
      usage: sumUsage("refine", result.usage),
    });
  } catch (error) {
    if (error instanceof InvalidRefinedPlanError) {
      console.warn("Plan edit rejected", { reason: error.reason });
      return jsonError(INVALID_REFINED_PLAN_MESSAGE, 502);
    }
    return modelError(error, "refine");
  }
}
