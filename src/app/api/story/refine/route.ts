import { zodTextFormat } from "openai/helpers/zod";
import { DEFAULT_FORMAT } from "@/lib/formats";
import { composeInstructions } from "@/lib/server/prompts";
import { getOpenAI, jsonError, modelError, STORY_MODEL } from "@/lib/server/openai";
import { readBody } from "@/lib/server/read-body";
import { refineOutput, refineRequest } from "@/lib/story-planning";
import { toUsageRecord } from "@/lib/usage";

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
    const response = await client.responses.parse({
      model: STORY_MODEL,
      store: false,
      instructions: composeInstructions("refine", parsed.data.format ?? DEFAULT_FORMAT),
      input: JSON.stringify(parsed.data),
      max_output_tokens: 10_000,
      text: { format: zodTextFormat(refineOutput, "refine") },
    });
    const usage = toUsageRecord("refine", STORY_MODEL, response.usage);
    console.info("Model usage", { step: "refine", model: STORY_MODEL, usage });
    if (response.status !== "completed" || !response.output_parsed) throw new Error("Incomplete model result");

    const { reply, changeSummary, plan } = response.output_parsed;
    if (
      !plan.scenes.length ||
      plan.scenes.some(
        (scene) =>
          !scene.shots.length ||
          scene.shots.some((shot) => !Number.isFinite(shot.seconds) || shot.seconds <= 0),
      )
    ) {
      return jsonError("The agent returned an invalid shot. Try rephrasing your request.", 502);
    }
    return Response.json({ reply, changeSummary, plan, usage });
  } catch (error) {
    return modelError(error, "refine");
  }
}
