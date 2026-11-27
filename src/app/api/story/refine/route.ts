import { getOpenAI, jsonError, modelError } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { INVALID_REFINED_PLAN_MESSAGE, InvalidRefinedPlanError, runRefine } from "@/lib/server/refine";
import { refineRequest } from "@/lib/story-planning";

export const runtime = "nodejs";
export const maxDuration = 100;

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
    const { reply, changeSummary, plan, usage } = await runRefine(client, parsed.data);
    return Response.json({ reply, changeSummary, plan, usage });
  } catch (error) {
    if (error instanceof InvalidRefinedPlanError) return jsonError(INVALID_REFINED_PLAN_MESSAGE, 502);
    return modelError(error, "refine");
  }
}
