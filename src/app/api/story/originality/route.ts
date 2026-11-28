import { originalityRequestSchema } from "@/lib/originality";
import { resolveStoryModel } from "@/lib/server/model-catalog";
import {
  createModelCaller,
  getOpenAI,
  jsonError,
  ModelOutputError,
  modelError,
  modelErrorMetadata,
} from "@/lib/server/openai";
import {
  hasStoryToCheck,
  NOTHING_TO_CHECK_MESSAGE,
  ORIGINALITY_BODY_BYTES,
  ORIGINALITY_FAILED_MESSAGE,
  runOriginality,
} from "@/lib/server/originality";
import { readBody } from "@/lib/server/read-body";

export const runtime = "nodejs";
// Review (75 s), then parallel Wikipedia lookups (6 s) and one comparison (60 s).
export const maxDuration = 150;

const ACCOUNT_ERROR_STATUSES = new Set([401, 403, 404, 429]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, ORIGINALITY_BODY_BYTES);
    if (!bytes) return jsonError("This story is too large to check.", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = originalityRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("Send a valid originality check request.", 400);
  if (!hasStoryToCheck(parsed.data)) return jsonError(NOTHING_TO_CHECK_MESSAGE, 400);

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to check originality.", 503);

  try {
    const result = await runOriginality(parsed.data, { callModel: createModelCaller(client, resolveStoryModel(request)) }, { signal: request.signal });
    return Response.json(result);
  } catch (error) {
    const metadata = modelErrorMetadata(error);
    if (metadata.status && ACCOUNT_ERROR_STATUSES.has(metadata.status)) return modelError(error, "originality");
    console.warn("Originality check failed", { ...metadata, references: parsed.data.references });
    const usage = error instanceof ModelOutputError ? [error.usage] : [];
    return Response.json({ error: ORIGINALITY_FAILED_MESSAGE, usage }, { status: 502 });
  }
}
