import { modelTestRequestSchema, type ModelTestResponse } from "@/lib/models";
import { geminiApiKey, isAllowedModel, testStoryModel, testVoiceModel } from "@/lib/server/model-catalog";
import { getOpenAI, jsonError } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1_024;

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, MAX_BODY_BYTES);
    if (!bytes) return jsonError("This request is too large.", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = modelTestRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("Choose a model to test.", 400);
  const { kind, model } = parsed.data;
  if (!isAllowedModel(kind, model)) return jsonError("This model can’t be used for this job.", 400);

  const result: ModelTestResponse =
    kind === "story"
      ? await testStoryModel(getOpenAI(), model, { signal: request.signal })
      : await testVoiceModel(geminiApiKey(), model, { signal: request.signal });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
