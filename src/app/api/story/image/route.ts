import {
  analyseImage,
  IncompleteImageAnalysisError,
  imageTypeFromHeader,
  isImageInputRejected,
  MAX_IMAGE_BYTES,
  matchesImageType,
  referenceName,
} from "@/lib/server/image-analysis";
import { resolveStoryModel } from "@/lib/server/model-catalog";
import { getOpenAI, jsonError, modelError, pinStoryModel } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const type = imageTypeFromHeader(request.headers.get("x-image-type"));
  if (!type) return jsonError("Choose a PNG, JPEG, or WebP image.", 415);

  let image: Uint8Array;
  try {
    const bytes = await readBody(request, MAX_IMAGE_BYTES);
    if (!bytes) return jsonError("Choose an image that’s 4 MB or smaller.", 413);
    if (!bytes.length) return jsonError("The image is empty.", 400);
    image = bytes;
  } catch {
    return jsonError("The upload was interrupted. Try again.", 400);
  }
  if (!matchesImageType(image, type)) return jsonError("This file isn’t a valid PNG, JPEG, or WebP image.", 415);

  const client = getOpenAI();
  if (!client) return jsonError("Add OPENAI_API_KEY to the server’s .env file to analyse images.", 503);

  try {
    const name = referenceName(request.headers.get("x-image-name"));
    const pinned = pinStoryModel(client, resolveStoryModel(request));
    return Response.json(await analyseImage(pinned, image, type, name, { signal: request.signal }));
  } catch (error) {
    if (error instanceof IncompleteImageAnalysisError) {
      return jsonError("The model couldn’t finish reading this image. Try again.", 502);
    }
    if (isImageInputRejected(error)) {
      console.warn("Model call failed", { step: "image-analysis", reason: "image input rejected" });
      return jsonError("This AI model can’t read images yet.", 422);
    }
    return modelError(error, "image-analysis");
  }
}
