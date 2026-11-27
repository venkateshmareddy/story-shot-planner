import OpenAI from "openai";
import {
  createDigest,
  DIGEST_BODY_BYTES,
  DIGEST_FAILED_MESSAGE,
  DigestError,
  digestRequest,
  openAIDigestModel,
} from "@/lib/server/digest";
import { getOpenAI, jsonError, modelError } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { checkSourceText, type DigestResponse, MAX_SOURCE_CHARACTERS } from "@/lib/source-text";

export const runtime = "nodejs";
export const maxDuration = 100;

const ACCOUNT_ERROR_STATUSES = new Set([401, 403, 404, 429]);
const tooLongError = `This story is too long to condense. The limit is ${MAX_SOURCE_CHARACTERS.toLocaleString("en")} characters (about 120 pages) — import a shorter part.`;

export async function POST(request: Request) {
  let body: unknown;
  try {
    const bytes = await readBody(request, DIGEST_BODY_BYTES);
    if (!bytes) return jsonError(tooLongError, 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("This request couldn’t be read.", 400);
  }

  const parsed = digestRequest.safeParse(body);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "text");
    return tooLong ? jsonError(tooLongError, 413) : jsonError("Send the story’s name and text to condense.", 400);
  }
  const source = checkSourceText(parsed.data.text, "This story");
  if (!source.ok) return jsonError(source.error, 400);

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to condense long stories.", 503);

  try {
    const result: DigestResponse = await createDigest(source.text, openAIDigestModel(client), {
      name: parsed.data.name,
      signal: request.signal,
    });
    console.info("Story digest", {
      characters: source.text.length,
      chunks: result.chunks,
      digestCharacters: result.digest.length,
      calls: result.usage.length,
    });
    return Response.json(result);
  } catch (error) {
    const cause = error instanceof DigestError ? error.cause : error;
    if (cause instanceof OpenAI.APIError && ACCOUNT_ERROR_STATUSES.has(cause.status ?? 0)) {
      return modelError(cause, "digest");
    }
    const usage = error instanceof DigestError ? error.usage : [];
    console.warn("Story digest failed", {
      chunks: error instanceof DigestError ? error.chunks : 0,
      calls: usage.length,
      reason: cause instanceof Error ? cause.name : "unknown",
    });
    return Response.json({ error: DIGEST_FAILED_MESSAGE, usage }, { status: 502 });
  }
}
