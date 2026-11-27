import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { mergeEdits, sanitizeEdits } from "../src/lib/agents/merge.ts";
import {
  type CallModel,
  DirectorError,
  type DirectorDeps,
  describeSpecialistFailure,
  directorFailureMessage,
  type ModelCall,
  ModelOutputError,
  runDirector,
  SPECIALIST_TIMEOUT_MS,
  SPECIALISTS,
  type SpecialistFailure,
  SYNTHESIS_MAX_OUTPUT_TOKENS,
  SYNTHESIS_TIMEOUT_MS,
} from "../src/lib/agents/orchestrator.ts";
import { MAX_SPECIALIST_EDITS, SPECIALIST_MAX_OUTPUT_TOKENS } from "../src/lib/agents/shared.ts";
import type { DirectorRequest } from "../src/lib/agents/types.ts";
import { maxDuration } from "../src/app/api/story/director/route.ts";
import { createModelCaller, modelErrorMetadata } from "../src/lib/server/openai.ts";
import { EDIT_PLAN_TIMEOUT_MS, EDIT_SCENE_TIMEOUT_MS } from "../src/lib/server/refine.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";
import type { UsageRecord, UsageStep } from "../src/lib/usage.ts";

const STORY_TEXT = "Elias reads the secret letter";
const SHOTS = 14;

function bigPlan(): ShotPlan {
  return {
    title: "The Letter",
    logline: "A widower finds a letter.",
    intent: "Quiet grief turning to hope.",
    characters: [{ name: "Elias", role: "Lead", look: "Grey cardigan", personality: "Reserved", voice: "Low" }],
    locations: [{ name: "Kitchen", description: "Morning light" }],
    scenes: [
      {
        title: "Morning",
        shots: Array.from({ length: SHOTS }, (_, index) => ({
          seconds: 4,
          framing: "Medium shot",
          camera: "Static tripod",
          characters: ["Elias"],
          location: "Kitchen",
          action: `${STORY_TEXT}, beat ${index + 1}.`,
          dialogue: [],
          emotion: "Hope",
          sound: "Kettle hiss",
        })),
      },
    ],
    reviewNotes: [],
  };
}

function request(message: string): DirectorRequest {
  return { plan: bigPlan(), messages: [], message };
}

const usageFor = (step: UsageStep, outputTokens = 5): UsageRecord => ({
  step,
  model: "fake",
  inputTokens: 10,
  outputTokens,
  totalTokens: 10 + outputTokens,
});

const soundEdits = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ scene: 1, shot: index + 1, field: "sound", value: `Rain ${index + 1}` }));

const advice = (summary: string, edits: unknown[] = []) => ({
  summary,
  recommendations: [{ target: "Overall", issue: "Flat", recommendation: "Vary it", rationale: "Mood", priority: "medium" }],
  edits,
});

function deps(handler: (call: ModelCall) => unknown): DirectorDeps & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const callModel: CallModel = async (call) => {
    calls.push(call);
    return { output: await handler(call), usage: usageFor(call.step) };
  };
  return {
    calls,
    callModel,
    refine: async () => {
      throw new Error("refine not expected");
    },
  };
}

const exhausted = (step: UsageStep) =>
  new ModelOutputError("Incomplete model result", usageFor(step, SPECIALIST_MAX_OUTPUT_TOKENS), "max_output_tokens");

// --- Edit clamp ---

test("sanitizeEdits keeps at most MAX_SPECIALIST_EDITS distinct edits, in the model's order", () => {
  assert.equal(MAX_SPECIALIST_EDITS, 10);
  const edits = sanitizeEdits(bigPlan(), "sound-director", ["sound"], soundEdits(SHOTS));
  assert.equal(edits.length, MAX_SPECIALIST_EDITS);
  assert.deepEqual(
    edits.map(({ shot }) => shot),
    Array.from({ length: MAX_SPECIALIST_EDITS }, (_, index) => index + 1),
  );
});

test("invalid and duplicate edits don't use up the edit budget", () => {
  const noise = [
    { scene: 1, shot: 1, field: "framing", value: "Wide" },
    { scene: 9, shot: 1, field: "sound", value: "Rain" },
    { scene: 1, shot: 1, field: "sound", value: "Kettle hiss" },
    { scene: 1, shot: 1, field: "sound", value: "Rain 1" },
    { scene: 1, shot: 1, field: "sound", value: "Thunder" },
  ];
  const edits = sanitizeEdits(bigPlan(), "sound-director", ["sound"], [...noise, ...soundEdits(SHOTS).slice(1)]);
  assert.equal(edits.length, MAX_SPECIALIST_EDITS);
  assert.equal(edits[0].value, "Rain 1");
  assert.equal(new Set(edits.map(({ key }) => key)).size, MAX_SPECIALIST_EDITS);
  assert.equal(mergeEdits(bigPlan(), edits).changeSummary.length, MAX_SPECIALIST_EDITS);
});

test("a specialist that ignores the edit rule can't bloat the proposal", async () => {
  const team = deps(() => advice("Rain throughout.", soundEdits(SHOTS)));
  const result = await runDirector(request("How should the music work?"), team);
  assert.deepEqual(result.specialists, ["sound-director"]);
  assert.equal(result.changeSummary.length, MAX_SPECIALIST_EDITS);
  const changed = result.plan?.scenes[0].shots.filter(({ sound }) => sound !== "Kettle hiss") ?? [];
  assert.equal(changed.length, MAX_SPECIALIST_EDITS);
});

test("every specialist prompt bounds its edits and prefers one recommendation over many identical edits", () => {
  for (const definition of Object.values(SPECIALISTS)) {
    assert.match(definition.instructions, /At most 10 edits, the ones with the most impact first/, definition.id);
    assert.match(definition.instructions, /say it once as a recommendation instead of editing each shot/, definition.id);
    assert.match(definition.instructions, /up to 5/, definition.id);
  }
});

// --- Budgets and timeouts ---

test("budgets: specialist and synthesis caps and timeouts fit the director route", async () => {
  assert.equal(SPECIALIST_MAX_OUTPUT_TOKENS, 2_800);
  assert.equal(SPECIALIST_TIMEOUT_MS, 90_000);
  assert.equal(SYNTHESIS_MAX_OUTPUT_TOKENS, 1_200);
  assert.equal(SYNTHESIS_TIMEOUT_MS, 30_000);
  const observedTokensPerSecond = 40;
  assert.ok((SPECIALIST_MAX_OUTPUT_TOKENS / observedTokensPerSecond) * 1_000 < SPECIALIST_TIMEOUT_MS);
  assert.ok(SPECIALIST_TIMEOUT_MS + SYNTHESIS_TIMEOUT_MS <= maxDuration * 1_000);
  assert.ok(EDIT_PLAN_TIMEOUT_MS + EDIT_SCENE_TIMEOUT_MS <= maxDuration * 1_000);

  const team = deps((call) => (call.step === "orchestrator" ? { reply: "Both.", conflicts: [] } : advice(call.step)));
  await runDirector(request("Lighting and a softer score"), team);
  const specialistCalls = team.calls.filter(({ step }) => step !== "orchestrator");
  assert.ok(specialistCalls.length >= 2);
  for (const call of specialistCalls) {
    assert.equal(call.maxOutputTokens, SPECIALIST_MAX_OUTPUT_TOKENS);
    assert.equal(call.timeoutMs, SPECIALIST_TIMEOUT_MS);
  }
  assert.equal(team.calls.find(({ step }) => step === "orchestrator")?.maxOutputTokens, SYNTHESIS_MAX_OUTPUT_TOKENS);
});

// --- Incomplete reason ---

function fakeClient(response: Record<string, unknown>) {
  return {
    responses: { parse: async () => response },
  } as unknown as OpenAI;
}

const signal = () => new AbortController().signal;

test("createModelCaller puts the incomplete reason on the ModelOutputError and the usage log", async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => logged.push(...args));
  const callModel = createModelCaller(
    fakeClient({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_parsed: null,
      model: "gpt-test",
      usage: { input_tokens: 9_000, output_tokens: 2_800, total_tokens: 11_800 },
    }),
  );
  const call = {
    step: "sound-director",
    instructions: "x",
    input: JSON.stringify({ plan: STORY_TEXT }),
    schema: SPECIALISTS["sound-director"].schema,
    maxOutputTokens: SPECIALIST_MAX_OUTPUT_TOKENS,
    signal: signal(),
  } satisfies ModelCall;
  await assert.rejects(callModel(call), (error) => {
    assert.ok(error instanceof ModelOutputError);
    assert.equal(error.reason, "max_output_tokens");
    assert.match(error.message, /max_output_tokens/);
    assert.equal(error.usage.outputTokens, 2_800);
    return true;
  });
  assert.equal((logged[1] as { reason?: string }).reason, "max_output_tokens");
  assert.ok(!JSON.stringify(logged).includes(STORY_TEXT));

  const unparsed = createModelCaller(fakeClient({ status: "completed", incomplete_details: null, output_parsed: null }));
  await assert.rejects(unparsed(call), (error) => error instanceof ModelOutputError && error.reason === "no_parsed_output");

  const ok = createModelCaller(fakeClient({ status: "completed", incomplete_details: null, output_parsed: { a: 1 } }));
  assert.deepEqual((await ok(call)).output, { a: 1 });
});

// --- Failure diagnosis and message ---

test("failure metadata names the error class, reason, status, code and tokens vs cap, never content", () => {
  const incomplete = describeSpecialistFailure("sound-director", exhausted("sound-director"));
  assert.deepEqual(incomplete, {
    id: "sound-director",
    error: "ModelOutputError",
    reason: "max_output_tokens",
    outputTokens: 2_800,
    maxOutputTokens: 2_800,
  });

  const api = new OpenAI.APIError(500, { code: "server_error", message: STORY_TEXT }, STORY_TEXT, new Headers());
  const failure = describeSpecialistFailure("cinematography-director", api);
  assert.equal(failure.status, 500);
  assert.equal(failure.code, "server_error");
  assert.equal(failure.maxOutputTokens, SPECIALIST_MAX_OUTPUT_TOKENS);
  assert.ok(!JSON.stringify(failure).includes(STORY_TEXT));

  const timeout = describeSpecialistFailure("editing-director", new DOMException("timed out", "TimeoutError"));
  assert.deepEqual(timeout, { id: "editing-director", error: "TimeoutError", maxOutputTokens: 2_800 });
  assert.deepEqual(modelErrorMetadata("boom"), { error: "string" });
});

test("a single expert that runs out of tokens gets a plain, actionable message and a diagnosable log", async () => {
  const failures: SpecialistFailure[] = [];
  const team = deps((call) => {
    throw exhausted(call.step);
  });
  await assert.rejects(
    runDirector(request("How should the music work?"), team, { onSpecialistFailure: (f) => failures.push(f) }),
    (error) => {
      assert.ok(error instanceof DirectorError);
      assert.deepEqual(error.failed, ["sound-director"]);
      assert.equal(
        directorFailureMessage(error.failed),
        "The Sound expert couldn’t finish this time. Try again, or ask about one scene.",
      );
      return true;
    },
  );
  assert.deepEqual(failures, [
    { id: "sound-director", error: "ModelOutputError", reason: "max_output_tokens", outputTokens: 2_800, maxOutputTokens: 2_800 },
  ]);
  assert.equal(
    directorFailureMessage(["cinematography-director", "sound-director"]),
    "The creative team couldn’t finish this time. Try again, or ask about one scene.",
  );
});

test("partial failures are reported too, and invalid output says so", async () => {
  const failures: SpecialistFailure[] = [];
  const team = deps((call) => {
    if (call.step === "sound-director") return { summary: "missing arrays" };
    if (call.step === "orchestrator") return { reply: "Camera only.", conflicts: [] };
    return advice("Camera");
  });
  const result = await runDirector(request("Lighting and a softer score"), team, {
    onSpecialistFailure: (f) => failures.push(f),
  });
  assert.deepEqual(result.failed, ["sound-director"]);
  assert.deepEqual(failures, [
    { id: "sound-director", error: "ModelOutputError", reason: "invalid_output", outputTokens: 5, maxOutputTokens: 2_800 },
  ]);
});
