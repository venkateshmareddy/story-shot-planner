import OpenAI from "openai";

export const STORY_MODEL = "gpt-6.2-sol";
export const TRANSCRIPTION_MODEL = "gpt-transcribe";

export function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  return apiKey ? new OpenAI({ apiKey, maxRetries: 0, timeout: 90_000 }) : null;
}

export function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export function modelError(error: unknown, step: string) {
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  const code = error instanceof OpenAI.APIError ? error.code : undefined;
  console.warn("Model call failed", { step, status, code });
  if (status === 401 || status === 403 || status === 404) {
    return jsonError("Check that the team API key is valid and has access to this model.", 503);
  }
  if (status === 429) {
    return jsonError("The team API key has reached a rate or usage limit. Check the account before retrying.", 429);
  }
  return jsonError("The model couldn’t complete this step. Your input is still available to retry.", 502);
}
