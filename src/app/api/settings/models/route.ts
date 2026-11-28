import type { ModelCatalog } from "@/lib/models";
import { geminiApiKey, loadModelCatalog } from "@/lib/server/model-catalog";
import { getOpenAI } from "@/lib/server/openai";

export const runtime = "nodejs";
export const maxDuration = 20;

const settled = (catalog: ModelCatalog) =>
  [catalog.story.status, catalog.voice.status].every((status) => status === "ok" || status === "no_key");

export async function GET(request: Request) {
  const catalog = await loadModelCatalog({ openai: getOpenAI(), geminiKey: geminiApiKey(), signal: request.signal });
  return Response.json(catalog, {
    headers: { "Cache-Control": settled(catalog) ? "private, max-age=60" : "no-store" },
  });
}
