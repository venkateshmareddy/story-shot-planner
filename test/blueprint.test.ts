import assert from "node:assert/strict";
import { test } from "node:test";
import { Packer } from "docx";
import { PDFDocument } from "pdf-lib";
import type { ImageReference } from "@/lib/agents/types";
import { type Blueprint, type BlueprintBlock, buildBlueprint, canExportFinal } from "@/lib/blueprint";
import { blueprintToDocx } from "@/lib/export/docx";
import { blueprintToPdf, toWinAnsi } from "@/lib/export/pdf";
import { createSession, type StorySession } from "@/lib/session";
import type { ShotPlan } from "@/lib/story-planning";

const DATE = new Date(2026, 10, 27, 15, 30);

type Shot = ShotPlan["scenes"][number]["shots"][number];

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    seconds: 4,
    framing: "Medium shot",
    camera: "Static tripod",
    characters: ["Elias"],
    location: "Kitchen",
    action: "Elias reads the letter.",
    dialogue: [{ speaker: "Elias", line: "She wrote back.", delivery: "Whispered" }],
    emotion: "Hope",
    sound: "Kettle hiss",
    ...overrides,
  };
}

function makePlan(): ShotPlan {
  return {
    title: "The Letter",
    logline: "A widower finds a letter from his late wife.",
    intent: "Quiet grief turning to hope.",
    characters: [{ name: "Elias", role: "Widower", look: "Grey cardigan", personality: "Reserved", voice: "Soft, slow" }],
    locations: [{ name: "Kitchen", description: "Small, warm morning light" }],
    scenes: [
      {
        title: "Morning",
        shots: [shot(), shot({ seconds: 6.5, framing: "Close-up", camera: "Slow push in", dialogue: [] })],
      },
      { title: "Garden", shots: [shot({ seconds: 50, location: "Garden", characters: ["Elias", "Mara"] })] },
    ],
    reviewNotes: ["Check the letter prop matches in every shot."],
  };
}

const reference: ImageReference = {
  id: "ref-1",
  name: "Window light",
  summary: "Soft side light through a kitchen window.",
  composition: "Off-centre subject",
  lighting: "Low warm key",
  cameraAngle: "Eye level",
  colour: "Amber and cream",
  environment: "Kitchen",
  mood: "Tender",
  shotIdeas: "Use for the opening close-up.",
};

function fullSession(): StorySession {
  return {
    ...createSession("Letter project"),
    phase: "refining",
    answered: [{ question: "Who is the main character?", answer: "Elias, a widower." }],
    collected: [{ label: "Tone", detail: "Gentle and hopeful" }],
    plan: makePlan(),
    references: [reference],
    messages: [
      { id: "m1", role: "user", text: "Make it warmer" },
      { id: "m2", role: "agent", text: "Done", status: "accepted", changeSummary: ["S01_SH02: switched to a slow push in"] },
      { id: "m3", role: "agent", text: "Nope", status: "rejected", changeSummary: ["Rejected change"] },
      { id: "m4", role: "agent", text: "Pending", status: "pending", changeSummary: ["Pending change"] },
      {
        id: "m5",
        role: "agent",
        text: "Advice",
        specialists: ["cinematography-director", "sound-director"],
        recommendations: [
          {
            specialist: "sound-director",
            target: "S02_SH01",
            issue: "Garden is silent.",
            recommendation: "Add birdsong.",
            rationale: "Signals the turn to hope.",
            priority: "low",
          },
          {
            specialist: "cinematography-director",
            target: "S01_SH01",
            issue: "Flat framing.",
            recommendation: "Frame Elias off-centre.",
            rationale: "Shows his isolation.",
            priority: "low",
          },
          {
            specialist: "cinematography-director",
            target: "Overall",
            issue: "Too many statics.",
            recommendation: "Add one handheld shot.",
            rationale: "Adds life.",
            priority: "high",
          },
        ],
        conflicts: ["Camera wants a handheld shot; Editing wants calm pacing."],
      },
      {
        id: "m6",
        role: "agent",
        text: "Reference",
        reference: { ...reference, id: "ref-2", name: "Garden dusk" },
      },
    ],
  };
}

function section(bp: Blueprint, id: string) {
  const found = bp.sections.find((item) => item.id === id);
  assert.ok(found, `missing section ${id}`);
  return found;
}

function text(blocks: BlueprintBlock[]): string {
  return JSON.stringify(blocks);
}

test("full session builds every section in order with real plan data", () => {
  const bp = buildBlueprint(fullSession(), { final: false, date: DATE });
  assert.deepEqual(
    bp.sections.map((item) => item.id),
    ["summary", "about", "known", "characters", "places", "scenes", "changes", "advice", "references", "checks", "answers"],
  );
  assert.deepEqual(
    bp.sections.map((item) => item.heading),
    [
      "One-line summary",
      "What the film is about",
      "What we know so far",
      "Characters",
      "Places",
      "Scenes and shots",
      "Approved changes",
      "Advice from the film team",
      "Reference images",
      "Things to check",
      "Interview answers",
    ],
  );
  assert.equal(bp.title, "The Letter");
  assert.equal(bp.runtimeSeconds, 60.5);
  assert.equal(bp.runtimeLabel, "1 min 1 s");
  assert.equal(bp.notice, null);

  const scenes = section(bp, "scenes").blocks.filter((block) => block.kind === "scene");
  assert.equal(scenes.length, 2);
  const first = scenes[0].kind === "scene" ? scenes[0].scene : null;
  assert.ok(first);
  assert.equal(first.shots[1].id, "S01_SH02");
  assert.equal(first.shots[1].length, "6.5 s");
  assert.equal(first.shots[1].framing, "Close-up");
  assert.equal(first.shots[1].camera, "Slow push in");
  assert.deepEqual(first.shots[0].dialogue, ["Elias: She wrote back. (Whispered)"]);
  assert.equal(first.length, "10.5 s");
  assert.match(text(section(bp, "scenes").blocks), /2 scenes, 3 shots, about 1 min 1 s in total/);
  assert.match(text(section(bp, "characters").blocks), /Elias \(Widower\)/);
  assert.match(text(section(bp, "checks").blocks), /letter prop/);
  assert.match(text(section(bp, "answers").blocks), /Elias, a widower/);
});

test("approved changes include only accepted proposals", () => {
  const changes = text(section(buildBlueprint(fullSession(), { final: false, date: DATE }), "changes").blocks);
  assert.match(changes, /slow push in/);
  assert.doesNotMatch(changes, /Rejected change|Pending change/);
});

test("advice is grouped by specialist, ordered by priority and labelled as not applied", () => {
  const blocks = section(buildBlueprint(fullSession(), { final: false, date: DATE }), "advice").blocks;
  assert.equal(blocks[0].kind, "paragraph");
  assert.match(text([blocks[0]]), /suggestions only.*not been applied/);
  const headings = blocks.filter((block) => block.kind === "subheading").map((block) => block.kind === "subheading" && block.text);
  assert.deepEqual(headings, ["Camera advice", "Sound advice", "Where the team disagrees"]);
  const camera = blocks[2];
  assert.ok(camera.kind === "list");
  assert.equal(camera.items[0].lead, "High priority, Overall");
  assert.match(camera.items[0].text, /Suggestion: Add one handheld shot\. Why: Adds life\./);
  assert.equal(camera.items[1].lead, "Low priority, S01_SH01");
  assert.match(text(blocks), /Editing wants calm pacing/);
});

test("reference images come from the session and agent messages without duplicates", () => {
  const blocks = section(buildBlueprint(fullSession(), { final: false, date: DATE }), "references").blocks;
  const names = blocks.filter((block) => block.kind === "subheading").map((block) => block.kind === "subheading" && block.text);
  assert.deepEqual(names, ["Window light", "Garden dusk"]);
  assert.match(text(blocks), /Low warm key/);
});

test("discovery session without a plan still builds a valid draft", () => {
  const session: StorySession = {
    ...createSession("Night bus"),
    answered: [{ question: "What happens?", answer: "Two strangers share a bus." }],
    collected: [{ label: "Setting", detail: "A night bus in winter" }],
  };
  const bp = buildBlueprint(session, { final: false, date: DATE });
  assert.equal(bp.title, "Night bus");
  assert.equal(bp.status, "Draft");
  assert.equal(bp.hasPlan, false);
  assert.ok(bp.notice);
  assert.equal(bp.runtimeSeconds, 0);
  assert.deepEqual(
    bp.sections.map((item) => item.id),
    ["known", "answers"],
  );
  assert.equal(canExportFinal(session), false);
  assert.throws(() => buildBlueprint(session, { final: true, date: DATE }), /needs a shot plan/);
  assert.deepEqual(buildBlueprint(createSession("Empty"), { final: false, date: DATE }).sections, []);
});

test("final and draft differ in status and header date", () => {
  const session = fullSession();
  assert.equal(canExportFinal(session), true);
  const draft = buildBlueprint(session, { final: false, date: DATE });
  const final = buildBlueprint(session, { final: true, date: DATE });
  assert.equal(draft.status, "Draft");
  assert.equal(draft.headerLabel, "DRAFT");
  assert.equal(final.status, "Final");
  assert.equal(final.dateLabel, "27 November 2026");
  assert.equal(final.headerLabel, "FINAL — 27 November 2026");
});

test("toWinAnsi maps arrows, keeps accents and drops emoji", () => {
  const supported = new Set([...Array.from({ length: 95 }, (_, index) => index + 32), 0xe9, 0x2014, 0x201c, 0x201d]);
  assert.equal(toWinAnsi("a → b 🎬 café", supported), "a -> b café");
  assert.equal(toWinAnsi("“ok” — ā", supported), "“ok” — a");
  assert.equal(toWinAnsi("日本", supported), "??");
});

test("blueprintToPdf returns a multi-page PDF and survives unicode and emoji", async () => {
  const session = fullSession();
  const plan = makePlan();
  plan.title = "The Letter → Hope 🎬 «日本» 👩‍👧";
  plan.logline = `Arrows → ← ⇒, emoji 🎞️🔥, smart “quotes”, ${"x".repeat(400)}`;
  plan.scenes = Array.from({ length: 6 }, (_, index) => ({
    title: `Scene ${index + 1} ✨`,
    shots: Array.from({ length: 8 }, () => shot({ action: "Elias walks → the window and waits for a very long time. ".repeat(4) })),
  }));
  session.plan = plan;
  const bytes = await blueprintToPdf(buildBlueprint(session, { final: true, date: DATE }));
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "%PDF");
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() > 1);

  const draft = await blueprintToPdf(buildBlueprint(createSession("Draft 🎬"), { final: false, date: DATE }));
  assert.equal(new TextDecoder().decode(draft.slice(0, 4)), "%PDF");
});

test("blueprintToDocx packs to a valid .docx zip", async () => {
  const session = fullSession();
  session.plan = { ...makePlan(), title: "Letter → 🎬 \u0007 control" };
  const buffer = await Packer.toBuffer(blueprintToDocx(buildBlueprint(session, { final: true, date: DATE })));
  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(buffer.length > 2000);
});
