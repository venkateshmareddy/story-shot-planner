import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryEditor } from "../src/app/story-editor.tsx";
import {
  addVisualLook,
  joinNames,
  LOOK_OPEN_TEXT,
  LOOK_SKIPPED_TEXT,
  lookRows,
  lookValue,
  openLooksLine,
} from "../src/lib/look-and-feel.ts";
import { createSession, type StorySession } from "../src/lib/session.ts";
import {
  type ContextFact,
  factKey,
  removeFact,
  type StoryContext,
  type VisualEntity,
  visualFactKey,
  visualStatus,
} from "../src/lib/story-context.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";

const noop = () => {};

const ocean: VisualEntity = { name: "Ocean", kind: "place", key: true };
const mara: VisualEntity = { name: "Mara", kind: "character", key: true };
const storm: VisualEntity = { name: "Stormy night", kind: "conditions", key: true };
const harbour: VisualEntity = { name: "Harbour", kind: "place", key: false };
const lantern: VisualEntity = { name: "Lantern", kind: "object", key: false };
const compass: VisualEntity = { name: "Compass", kind: "object", key: true, closed: true };
const keeper: VisualEntity = { name: "Keeper", kind: "character", key: true, closed: true };

const storyIdea: ContextFact = { category: "concept", label: "Story idea", value: "A keeper waits out a storm", source: "user", approved: true };
const tone: ContextFact = { category: "genre", label: "Tone", value: "Quiet drama", source: "ai", approved: false };
const stormLook: ContextFact = { category: "lighting", label: "Stormy night", value: "Blue-black sky, rain in the lamp", source: "user", approved: true };
const harbourLook: ContextFact = { category: "locations", label: "Harbour look", value: "Rusted cranes in fog", source: "ai", approved: false };
const keeperLook: ContextFact = { category: "characters", label: "Keeper look", value: "Oilskin coat, grey beard", source: "ai", approved: false };

function lookContext(): StoryContext {
  return {
    facts: [storyIdea, tone, stormLook, harbourLook, keeperLook],
    unresolved: [],
    visuals: [mara, ocean, lantern, storm, harbour, compass, keeper],
  };
}

function render(session: StorySession, options: { busy?: boolean; addLook?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(StoryEditor, {
      session,
      busy: options.busy ?? false,
      onEditPlan: noop,
      onApproveFact: noop,
      onRemoveFact: noop,
      onEditFact: noop,
      ...(options.addLook === false ? {} : { onAddLook: noop }),
    }),
  );
}

function withContext(context: StoryContext): StorySession {
  return { ...createSession("Keeper"), context };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function lookGroup(html: string): string {
  const start = html.indexOf('<div class="context-group look-group">');
  assert.notEqual(start, -1, "Look and feel group is missing");
  return html.slice(start, html.indexOf("</div>", start));
}

function rowFor(html: string, name: string): string {
  const group = lookGroup(html);
  const start = group.indexOf(`<span class="context-fact-label">${name}<`);
  assert.notEqual(start, -1, `row for ${name} is missing`);
  return group.slice(start, group.indexOf("</li>", start));
}

test("look rows: key things and things with a look, conditions → places → objects → characters, then first mention", () => {
  const rows = lookRows(lookContext());
  assert.deepEqual(
    rows.map((row) => row.entity.name),
    ["Stormy night", "Ocean", "Harbour", "Compass", "Mara", "Keeper"],
  );
  assert.deepEqual(
    rows.map((row) => row.status),
    ["confirmed", "open", "ai", "skipped", "open", "skipped"],
  );
  assert.equal(lookRows({ facts: [], unresolved: [] }).length, 0);
});

test("look rows list a thing once even if the same look key is tracked twice", () => {
  const context: StoryContext = { facts: [], unresolved: [], visuals: [ocean, { ...ocean, name: "ocean " }] };
  assert.equal(lookRows(context).length, 1);
});

test("open and skipped looks have plain texts", () => {
  const rows = lookRows(lookContext());
  const byName = (name: string) => rows.find((row) => row.entity.name === name);
  assert.equal(lookValue(byName("Ocean")!), LOOK_OPEN_TEXT);
  assert.equal(LOOK_OPEN_TEXT, "Not described yet");
  assert.equal(lookValue(byName("Compass")!), LOOK_SKIPPED_TEXT);
  assert.equal(LOOK_SKIPPED_TEXT, "Skipped — the AI will choose a look");
  assert.equal(lookValue(byName("Keeper")!), "Oilskin coat, grey beard");
});

test("open-looks line names key open looks naturally and hides when none", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Ocean"]), "Ocean");
  assert.equal(joinNames(["Ocean", "Mara"]), "Ocean and Mara");
  assert.equal(joinNames(["Ocean", "Mara", "Lamp"]), "Ocean, Mara and Lamp");
  assert.equal(
    openLooksLine(lookRows(lookContext())),
    "Looks still open: Ocean and Mara — answer in chat or let the AI decide.",
  );
  const settled = addVisualLook(addVisualLook(lookContext(), ocean, "Grey swell"), mara, "Red scarf");
  assert.equal(openLooksLine(lookRows(settled)), null);
  assert.doesNotMatch(render(withContext(settled)), /Looks still open/);
  assert.match(render(withContext(lookContext())), /Looks still open: Ocean and Mara — answer in chat or let the AI decide\./);
});

test("addVisualLook creates a confirmed fact with the exact category and label, immutably", () => {
  const before = lookContext();
  const snapshot = structuredClone(before);
  const next = addVisualLook(before, ocean, "  Grey swell under low cloud  ");
  assert.deepEqual(before, snapshot);
  const added = next.facts.find((fact) => factKey(fact) === visualFactKey(ocean));
  assert.deepEqual(added, { category: "locations", label: "Ocean look", value: "Grey swell under low cloud", source: "user", approved: true });
  assert.deepEqual(next.visuals, before.visuals);
  assert.equal(visualStatus(next, ocean).status, "confirmed");

  const weather = addVisualLook({ facts: [], unresolved: [], visuals: [{ ...storm }] }, { ...storm, name: "Dawn fog" }, "Milky light");
  assert.deepEqual(weather.facts[0], { category: "lighting", label: "Dawn fog", value: "Milky light", source: "user", approved: true });

  const character = addVisualLook(lookContext(), mara, "Red scarf");
  assert.equal(character.facts.at(-1)?.category, "characters");
  assert.equal(character.facts.at(-1)?.label, "Mara look");

  assert.equal(addVisualLook(before, ocean, "   "), before);
});

test("addVisualLook replaces an AI look and re-adds a look the filmmaker removed earlier", () => {
  const replaced = addVisualLook(lookContext(), harbour, "Clean white quay");
  const harbourFacts = replaced.facts.filter((fact) => factKey(fact) === visualFactKey(harbour));
  assert.equal(harbourFacts.length, 1);
  assert.equal(harbourFacts[0].source, "user");
  assert.equal(harbourFacts[0].value, "Clean white quay");

  const removed = removeFact(lookContext(), visualFactKey(harbour));
  assert.equal(removed.removed?.length, 1);
  const readded = addVisualLook(removed, harbour, "rusted cranes in fog");
  assert.equal(visualStatus(readded, harbour).status, "confirmed");
  assert.equal(readded.removed, undefined);
});

test("status chips and actions per status; nothing shows twice", () => {
  const html = render(withContext(lookContext()));
  assert.match(html, /<h4 class="editor-subhead">Look and feel<\/h4>/);

  const stormRow = rowFor(html, "Stormy night");
  assert.match(stormRow, /<span class="look-kind">Time &amp; weather<\/span>/);
  assert.match(stormRow, /<span class="look-chip look-chip-confirmed">From you<\/span>/);
  assert.match(stormRow, /aria-label="Edit: Stormy night"/);
  assert.match(stormRow, /aria-label="Remove: Stormy night"/);
  assert.doesNotMatch(stormRow, /Approve/);

  const harbourRow = rowFor(html, "Harbour");
  assert.match(harbourRow, /<span class="look-kind">Place<\/span>/);
  assert.match(harbourRow, /<span class="look-chip look-chip-ai">AI suggestion<\/span>/);
  for (const action of ["Approve", "Edit", "Remove"]) assert.match(harbourRow, new RegExp(`aria-label="${action}: Harbour look"`));

  const oceanRow = rowFor(html, "Ocean");
  assert.match(oceanRow, /<span class="look-chip look-chip-open">Open<\/span>/);
  assert.match(oceanRow, /Not described yet/);
  assert.match(oceanRow, /aria-label="Add a look: Ocean"[^>]*>Add a look</);

  const compassRow = rowFor(html, "Compass");
  assert.match(compassRow, /<span class="look-kind">Object<\/span>/);
  assert.match(compassRow, /<span class="look-chip look-chip-skipped">Skipped<\/span>/);
  assert.match(compassRow, /Skipped — the AI will choose a look/);
  assert.match(compassRow, /Add a look/);

  const keeperRow = rowFor(html, "Keeper");
  assert.match(keeperRow, /<span class="look-kind">Character<\/span>/);
  assert.match(keeperRow, /look-chip-skipped/);
  assert.match(keeperRow, /aria-label="Approve: Keeper look"/);

  assert.doesNotMatch(lookGroup(html), /Lantern/);
  for (const fact of [stormLook, harbourLook, keeperLook]) assert.equal(count(html, fact.value), 1, fact.label);
  assert.doesNotMatch(html, /(Stormy night|Harbour look|Keeper look)<span class="muted context-fact-category">/);
  assert.match(html, /A keeper waits out a storm/);
  assert.match(html, /<h4 class="editor-subhead">From you<\/h4>/);
  assert.match(html, /<h4 class="editor-subhead">AI suggestions<\/h4>/);
});

test("look groups hide visual facts from the other groups", () => {
  const context: StoryContext = { facts: [stormLook, harbourLook], unresolved: [], visuals: [storm, harbour] };
  const html = render(withContext(context));
  assert.doesNotMatch(html, /<h4 class="editor-subhead">From you<\/h4>/);
  assert.doesNotMatch(html, /<h4 class="editor-subhead">AI suggestions<\/h4>/);
  assert.match(html, /Look and feel/);
});

test("look actions are disabled while busy and Add a look is hidden when not wired", () => {
  const busy = lookGroup(render(withContext(lookContext()), { busy: true }));
  const buttons = busy.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length >= 8);
  for (const button of buttons) assert.match(button, /disabled=""/);
  const unwired = render(withContext(lookContext()), { addLook: false });
  assert.doesNotMatch(unwired, /Add a look/);
  assert.match(unwired, /Not described yet/);
});

test("old context without visuals renders exactly as before", () => {
  const context: StoryContext = { facts: [storyIdea, tone, { ...harbourLook, approved: true }], unresolved: ["Who is the visitor?"] };
  const old = render(withContext(context));
  assert.doesNotMatch(old, /Look and feel|look-chip|Looks still open/);
  assert.match(old, /Harbour look<span class="muted context-fact-category"> · Places and setting<\/span>/);
  assert.match(old, /<h4 class="editor-subhead">Approved<\/h4>/);
  assert.equal(render(withContext({ ...context, visuals: [] })), old);
  assert.equal(render(withContext({ ...context, visuals: [lantern] })), old);
});

test("the refining-phase Story details panel shows the Look and feel group", () => {
  const plan: ShotPlan = { title: "T", logline: "", intent: "", characters: [], locations: [], scenes: [], reviewNotes: [] };
  const html = render({ ...withContext(lookContext()), phase: "refining", plan });
  assert.match(html, /<summary class="editor-section-head">Story details<\/summary>/);
  assert.match(html, /Look and feel/);
  const looksOnly = render({ ...withContext({ facts: [], unresolved: [], visuals: [ocean] }), phase: "refining", plan });
  assert.match(looksOnly, /Story details/);
  assert.match(looksOnly, /Looks still open: Ocean/);
});
