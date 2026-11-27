import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { POST } from "../src/app/api/story/image/route.ts";
import { cinematographyDirector, MAX_CONTEXT_REFERENCES } from "../src/lib/agents/cinematography-director.ts";
import { directorRequest, IMAGE_REFERENCE_TEXT_MAX, MAX_IMAGE_REFERENCES } from "../src/lib/agents/schemas.ts";
import type { ImageReference } from "../src/lib/agents/types.ts";
import {
  analyseImage,
  buildImageInput,
  DEFAULT_REFERENCE_NAME,
  IMAGE_ANALYSIS_INSTRUCTIONS,
  imageAnalysisOutput,
  IncompleteImageAnalysisError,
  imageTypeFromHeader,
  isImageInputRejected,
  MAX_IMAGE_BYTES,
  matchesImageType,
  referenceName,
  toImageReference,
} from "../src/lib/server/image-analysis.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56]);

const analysis = {
  summary: "A figure stands at a rainy window at dusk.",
  composition: "Subject on the left third, deep background.",
  lighting: "Soft cool window light from the right.",
  cameraAngle: "Medium shot at eye level.",
  colour: "Muted blues with a warm lamp accent.",
  environment: "A small kitchen with rain on the glass.",
  mood: "Quiet and lonely.",
  shotIdeas: "Use a slow push-in through the window for the letter scene.",
};

const reference = (index: number): ImageReference => ({
  id: `ref-${index}`,
  name: `Ref ${index}`,
  ...analysis,
});

const plan: ShotPlan = {
  title: "The Letter",
  logline: "A widower finds a letter.",
  intent: "Quiet grief turning to hope.",
  characters: [
    {
      name: "Elias",
      role: "Lead",
      look: "Grey cardigan",
      personality: "Reserved",
      voice: "Low",
    },
  ],
  locations: [{ name: "Kitchen", description: "Morning light" }],
  scenes: [
    {
      title: "Morning",
      shots: [
        {
          seconds: 4,
          framing: "Medium shot",
          camera: "Static tripod",
          characters: ["Elias"],
          location: "Kitchen",
          action: "Elias reads the letter.",
          dialogue: [],
          emotion: "Hope",
          sound: "Kettle hiss",
        },
      ],
    },
  ],
  reviewNotes: [],
};

test("analysis schema accepts valid output and rejects invalid output", () => {
  assert.ok(imageAnalysisOutput.safeParse(analysis).success);
  const { mood: _mood, ...missing } = analysis;
  assert.ok(!imageAnalysisOutput.safeParse(missing).success);
  assert.ok(!imageAnalysisOutput.safeParse({ ...analysis, lighting: 3 }).success);
  assert.ok(!imageAnalysisOutput.safeParse(null).success);
});

test("instructions forbid identifying people and stick to what is visible", () => {
  assert.match(IMAGE_ANALYSIS_INSTRUCTIONS, /Never identify real people/);
  assert.match(IMAGE_ANALYSIS_INSTRUCTIONS, /Describe only what is visible/);
});

test("image type validator allows png, jpeg and webp only", () => {
  assert.equal(imageTypeFromHeader("image/png"), "image/png");
  assert.equal(imageTypeFromHeader(" Image/JPEG "), "image/jpeg");
  assert.equal(imageTypeFromHeader("image/webp"), "image/webp");
  for (const bad of ["image/gif", "image/svg+xml", "", null, undefined, "text/html"]) {
    assert.equal(imageTypeFromHeader(bad), null, String(bad));
  }
});

test("byte signatures must match the declared type", () => {
  assert.ok(matchesImageType(PNG, "image/png"));
  assert.ok(matchesImageType(JPEG, "image/jpeg"));
  assert.ok(matchesImageType(WEBP, "image/webp"));
  assert.ok(!matchesImageType(JPEG, "image/png"));
  assert.ok(!matchesImageType(PNG, "image/webp"));
  assert.ok(!matchesImageType(new TextEncoder().encode("<svg></svg>"), "image/jpeg"));
});

test("input builder sends a low-detail base64 data URL", () => {
  const [message] = buildImageInput(PNG, "image/png") as [
    {
      role: string;
      content: [{ type: string; text: string }, { type: string; image_url: string; detail: string }];
    },
  ];
  assert.equal(message.role, "user");
  assert.equal(message.content[0].type, "input_text");
  assert.equal(message.content[1].type, "input_image");
  assert.equal(message.content[1].image_url, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  assert.equal(message.content[1].detail, "low");
});

test("reference name is sanitised with a fallback", () => {
  assert.equal(referenceName(null), DEFAULT_REFERENCE_NAME);
  assert.equal(referenceName("   "), DEFAULT_REFERENCE_NAME);
  assert.equal(referenceName(encodeURIComponent("Café\nnight.jpg")), "Café night.jpg");
  assert.equal(referenceName("%E0%A4%A"), "%E0%A4%A");
  assert.ok(referenceName("x".repeat(500)).length <= 120);
});

test("model output becomes a clipped ImageReference", () => {
  const long = toImageReference({ ...analysis, summary: "a ".repeat(2_000) }, "Ref", "id-1");
  assert.equal(long.id, "id-1");
  assert.ok(long.summary.length <= IMAGE_REFERENCE_TEXT_MAX);
  assert.ok(directorRequest.shape.references.safeParse([long]).success);
});

test("image rejection is detected only for 400-class image errors", () => {
  const rejected = new OpenAI.BadRequestError(
    400,
    {
      message: "Invalid content type. image_url is only supported by certain models.",
    },
    undefined,
    new Headers(),
  );
  assert.ok(isImageInputRejected(rejected));
  assert.ok(
    !isImageInputRejected(new OpenAI.BadRequestError(400, { message: "Bad schema" }, undefined, new Headers())),
  );
  assert.ok(
    !isImageInputRejected(new OpenAI.AuthenticationError(401, { message: "Bad image key" }, undefined, new Headers())),
  );
  assert.ok(!isImageInputRejected(new Error("image")));
});

test("directorRequest accepts up to 6 references and rejects more", () => {
  const base = { plan, messages: [], message: "Make shot 1 moodier" };
  assert.ok(directorRequest.safeParse(base).success);
  const six = Array.from({ length: MAX_IMAGE_REFERENCES }, (_, index) => reference(index));
  assert.ok(directorRequest.safeParse({ ...base, references: six }).success);
  assert.ok(!directorRequest.safeParse({ ...base, references: [...six, reference(6)] }).success);
  const oversized = {
    ...reference(0),
    summary: "x".repeat(IMAGE_REFERENCE_TEXT_MAX + 1),
  };
  assert.ok(!directorRequest.safeParse({ ...base, references: [oversized] }).success);
});

test("cinematography context includes up to 4 references and omits them when absent", () => {
  const build = cinematographyDirector.buildContext as (p: ShotPlan, r?: ImageReference[]) => Record<string, unknown>;
  assert.ok(!("references" in build(plan)));
  assert.ok(!("references" in build(plan, [])));
  const context = build(
    plan,
    Array.from({ length: 6 }, (_, index) => reference(index)),
  );
  const refs = context.references as Record<string, string>[];
  assert.equal(refs.length, MAX_CONTEXT_REFERENCES);
  assert.deepEqual(
    refs.map((ref) => ref.name),
    ["Ref 0", "Ref 1", "Ref 2", "Ref 3"],
  );
  assert.ok(!("id" in refs[0]) && !("environment" in refs[0]));
  assert.ok("shotIdeas" in refs[0] && "lighting" in refs[0]);
  assert.match(cinematographyDirector.instructions, /plan\.references/);
});

function upload(body: Uint8Array | null, type?: string, length?: number) {
  const headers = new Headers();
  if (type) headers.set("x-image-type", type);
  if (length !== undefined) headers.set("content-length", String(length));
  return new Request("http://localhost/api/story/image", {
    method: "POST",
    headers,
    body,
  });
}

test("route rejects bad uploads before any model call", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal((await POST(upload(PNG, "image/gif"))).status, 415);
    assert.equal((await POST(upload(PNG))).status, 415);
    assert.equal((await POST(upload(PNG, "image/png", MAX_IMAGE_BYTES + 1))).status, 413);
    assert.equal((await POST(upload(new Uint8Array(MAX_IMAGE_BYTES + 1), "image/png"))).status, 413);
    assert.equal((await POST(upload(new Uint8Array(), "image/png"))).status, 400);
    assert.equal((await POST(upload(JPEG, "image/png"))).status, 415);
    const noKey = await POST(upload(PNG, "image/png"));
    assert.equal(noKey.status, 503);
    assert.ok(!JSON.stringify(await noKey.json()).includes("base64"));
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

function fakeClient(result: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    responses: {
      parse: async (body: Record<string, unknown>) => {
        calls.push(body);
        return result;
      },
    },
  } as unknown as Parameters<typeof analyseImage>[0];
  return { client, calls };
}

const usage = { input_tokens: 120, output_tokens: 80, total_tokens: 200 };

test("analyseImage makes one bounded call and returns a reference with usage", async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => logged.push(...args));
  const { client, calls } = fakeClient({ status: "completed", output_parsed: analysis, usage });
  const result = await analyseImage(client, PNG, "image/png", "Window");
  assert.equal(calls.length, 1);
  const body = calls[0] as {
    store: boolean;
    max_output_tokens: number;
    text: { format: { name: string } };
    input: { content: { detail?: string }[] }[];
  };
  assert.equal(body.store, false);
  assert.ok(body.max_output_tokens <= 1_000);
  assert.equal(body.text.format.name, "image_analysis");
  assert.equal(body.input[0].content[1].detail, "low");
  assert.equal(result.reference.name, "Window");
  assert.equal(result.reference.mood, analysis.mood);
  assert.match(result.reference.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { step: result.usage.step, total: result.usage.totalTokens },
    { step: "image-analysis", total: 200 },
  );
  assert.ok(!JSON.stringify(logged).includes(Buffer.from(PNG).toString("base64")));
});

test("analyseImage rejects incomplete or empty model output", async (t) => {
  t.mock.method(console, "info", () => {});
  for (const result of [
    { status: "incomplete", output_parsed: analysis, usage },
    { status: "completed", output_parsed: null, usage },
    { status: "completed", output_parsed: { ...analysis, summary: "  " }, usage },
  ]) {
    await assert.rejects(analyseImage(fakeClient(result).client, PNG, "image/png", "x"), IncompleteImageAnalysisError);
  }
});
