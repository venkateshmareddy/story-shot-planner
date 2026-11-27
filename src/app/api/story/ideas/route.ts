import type { IdeasResponse } from "@/lib/ideas";
import { IDEAS_BODY_BYTES, IdeasError, ideasRequest, openAIIdeasModel, runIdeas } from "@/lib/server/ideas";
import { getOpenAI, jsonError, modelError } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, IDEAS_BODY_BYTES);
    if (!bytes) return jsonError("This request is too large.", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = ideasRequest.safeParse(body);
  if (!parsed.success) return jsonError("Send a valid story-ideas request.", 400);

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to get story ideas.", 503);

  try {
    const result: IdeasResponse = await runIdeas(parsed.data, openAIIdeasModel(client), { signal: request.signal });
    return Response.json(result);
  } catch (error) {
    if (error instanceof IdeasError) {
      console.warn("Story ideas failed", { mode: parsed.data.mode, reason: error.reason });
      return Response.json({ error: error.message, usage: error.usage }, { status: 502 });
    }
    return modelError(error, "ideas");
  }
}
