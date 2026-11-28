import { engagementRequestSchema } from "@/lib/engagement";
import {
  ENGAGEMENT_BODY_BYTES,
  ENGAGEMENT_FAILED_MESSAGE,
  EngagementError,
  engagementInputProblem,
  runEngagement,
} from "@/lib/server/engagement";
import { resolveStoryModel } from "@/lib/server/model-catalog";
import { createModelCaller, getOpenAI, jsonError, modelError, modelErrorMetadata } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";

export const runtime = "nodejs";
// Prewarm and parallel scene calls (≤100 s), then one summary call (75 s).
export const maxDuration = 180;

const ACCOUNT_ERROR_STATUSES = new Set([401, 403, 404, 429]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, ENGAGEMENT_BODY_BYTES);
    if (!bytes) return jsonError("This story is too large to assess.", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = engagementRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("Send a valid engagement report request.", 400);
  const problem = engagementInputProblem(parsed.data.plan);
  if (problem) return jsonError(problem, 400);

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to predict engagement.", 503);

  try {
    const result = await runEngagement(parsed.data, createModelCaller(client, resolveStoryModel(request)), { signal: request.signal });
    return Response.json(result);
  } catch (error) {
    const cause = error instanceof EngagementError ? error.cause : error;
    const metadata = modelErrorMetadata(cause);
    if (metadata.status && ACCOUNT_ERROR_STATUSES.has(metadata.status)) return modelError(cause, "engagement");
    console.warn("Engagement report failed", {
      ...metadata,
      failure: error instanceof EngagementError ? error.failure : "unexpected",
      scenes: parsed.data.plan.scenes.length,
    });
    const usage = error instanceof EngagementError ? error.usage : [];
    return Response.json({ error: ENGAGEMENT_FAILED_MESSAGE, usage }, { status: 502 });
  }
}
