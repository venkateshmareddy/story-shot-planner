import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionMenu } from "../src/app/action-menu.tsx";
import { ConversationPanel } from "../src/app/conversation-panel.tsx";
import { MENU_EDGE, MENU_GAP, menuKeyTarget, menuPosition } from "../src/lib/action-menu-ui.ts";
import { EXPERT_ACTIONS, FULL_REVIEW_ACTION, REPORT_ACTIONS, reportName } from "../src/lib/quick-actions.ts";
import { createSession, type StorySession } from "../src/lib/session.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";

const plan: ShotPlan = { title: "T", logline: "", intent: "", characters: [], locations: [], scenes: [], reviewNotes: [] };
const noop = () => {};

function renderPanel(session: StorySession, busy = false): string {
  return renderToStaticMarkup(
    createElement(ConversationPanel, {
      session,
      busy,
      error: "",
      input: "",
      transcribing: false,
      voiceError: "",
      micError: "",
      voiceAdded: 0,
      canGeneratePlan: false,
      uploading: null,
      stopNotice: "",
      openReport: null,
      onOpenReport: noop,
      onInput: noop,
      onSend: noop,
      onStop: noop,
      onStopUpload: noop,
      onQuickAction: noop,
      onDiscoveryAction: noop,
      onAnswerOption: noop,
      onGeneratePlan: noop,
      onAccept: noop,
      onReject: noop,
      onEditAnswer: () => true,
      onVoice: noop,
      onVoiceActive: noop,
      onClearMicError: noop,
      onUpload: noop,
      onRetry: noop,
    }),
  );
}

type RenderedButton = { attrs: Record<string, string>; text: string; inner: string };

function buttons(html: string): RenderedButton[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, rawAttrs = "", inner = ""]) => ({
    attrs: Object.fromEntries([...rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name = "", value = ""]) => [name, value])),
    inner,
    text: inner
      .replace(/<span[^>]*(?:aria-hidden="true"|hidden="")[^>]*>[\s\S]*?<\/span>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&"),
  }));
}

function refineRow(html: string): string {
  const row = html.match(/<fieldset class="quick-actions quick-actions-refine">[\s\S]*?<\/fieldset>/)?.[0];
  assert.ok(row, "refining action row is rendered");
  return row;
}

const refining = (): StorySession => ({ ...createSession("Test"), phase: "refining", plan });

test("after a plan exists the row shows Full review, Ask an expert, then the two report buttons", () => {
  const row = refineRow(renderPanel(refining()));
  const shown = buttons(row);
  assert.deepEqual(
    shown.map((button) => button.text),
    ["Full review", "Ask an expert", "Originality", "Attention"],
  );
  const [fullReview, menu, originality, retention] = shown;
  assert.equal(fullReview?.attrs.title, FULL_REVIEW_ACTION.message);
  assert.equal(menu?.attrs["aria-haspopup"], "menu");
  assert.equal(menu?.attrs["aria-expanded"], "false");
  assert.doesNotMatch(row, /role="menu"/, "the menu stays closed until opened");
  assert.match(row, /<div class="refine-actions-group refine-actions-reports">/, "reports sit in their own group after the divider");
  for (const [button, action] of [
    [originality, REPORT_ACTIONS[0]],
    [retention, REPORT_ACTIONS[1]],
  ] as const) {
    assert.ok(button && action);
    assert.equal(button.attrs.class, `quick-action refine-action quick-action-${action.id}`);
    assert.equal(button.attrs["aria-label"], reportName(action));
    assert.ok(button.attrs["aria-label"]?.toLowerCase().includes(button.text.toLowerCase()), "visible label is in the name");
    assert.ok(button.attrs.title?.startsWith(action.label), "tooltip starts with the full name");
    const tipId = button.attrs["aria-describedby"];
    assert.ok(tipId);
    assert.ok(button.inner.includes(`<span id="${tipId}" hidden="">${action.tooltip}</span>`));
  }
  assert.deepEqual(
    [originality?.attrs["aria-label"], retention?.attrs["aria-label"]],
    ["Check story originality", "Attention — Audience Retention Predictor"],
  );
});

test("Full review and the expert menu are disabled while a request runs; report buttons stay available", () => {
  const shown = buttons(refineRow(renderPanel(refining(), true)));
  assert.deepEqual(
    shown.map((button) => [button.text, "disabled" in button.attrs]),
    [
      ["Full review", true],
      ["Ask an expert", true],
      ["Originality", false],
      ["Attention", false],
    ],
  );
});

test("without a plan the row has no report buttons", () => {
  const row = refineRow(renderPanel({ ...createSession("Test"), phase: "refining" }));
  assert.deepEqual(
    buttons(row).map((button) => button.text),
    ["Full review", "Ask an expert"],
  );
  assert.doesNotMatch(row, /refine-actions-reports/);
});

test("the discovery row is unchanged", () => {
  const expected = (disabled: boolean) =>
    `<fieldset class="quick-actions"><legend class="sr-only">Quick replies</legend>` +
    `<button class="quick-action" type="button"${disabled ? ` disabled=""` : ""}>You decide</button>` +
    `<button class="quick-action" type="button"${disabled ? ` disabled=""` : ""}>Skip</button>` +
    `<button class="quick-action" type="button">Create plan now</button></fieldset>`;
  const asking = renderPanel({ ...createSession("Test"), pendingQuestion: "Who is the hero?" });
  assert.ok(asking.includes(expected(false)));
  const idle = renderPanel(createSession("Test"));
  assert.ok(idle.includes(expected(true)));
  for (const html of [asking, idle]) {
    assert.doesNotMatch(html, /quick-actions-refine|aria-haspopup/);
  }
});

test("the menu button renders closed with menu-button semantics", () => {
  const html = renderToStaticMarkup(
    createElement(ActionMenu, { label: "Ask an expert", items: EXPERT_ACTIONS, disabled: false, onSelect: noop }),
  );
  const [trigger, ...rest] = buttons(html);
  assert.equal(rest.length, 0);
  assert.equal(trigger?.text, "Ask an expert");
  assert.equal(trigger?.attrs["aria-haspopup"], "menu");
  assert.equal(trigger?.attrs["aria-expanded"], "false");
  assert.equal(trigger?.attrs["aria-controls"], undefined);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
});

test("menu keys move focus with wrap-around, Home and End", () => {
  assert.equal(menuKeyTarget("ArrowDown", 0, 5), 1);
  assert.equal(menuKeyTarget("ArrowDown", 4, 5), 0);
  assert.equal(menuKeyTarget("ArrowUp", 0, 5), 4);
  assert.equal(menuKeyTarget("ArrowUp", 3, 5), 2);
  assert.equal(menuKeyTarget("ArrowDown", -1, 5), 0);
  assert.equal(menuKeyTarget("ArrowUp", -1, 5), 4);
  assert.equal(menuKeyTarget("Home", 3, 5), 0);
  assert.equal(menuKeyTarget("End", 1, 5), 4);
  for (const key of ["Enter", " ", "Escape", "Tab", "a"]) assert.equal(menuKeyTarget(key, 2, 5), null, key);
  assert.equal(menuKeyTarget("ArrowDown", -1, 0), null);
});

test("the menu opens below when it fits and upward when the row sits near the bottom", () => {
  const viewport = { width: 1280, height: 800 };
  const menu = { width: 272, height: 240 };
  assert.deepEqual(menuPosition({ top: 100, bottom: 130, left: 400 }, menu, viewport), {
    side: "below",
    top: 130 + MENU_GAP,
    left: 400,
    maxHeight: 800 - 130 - MENU_GAP - MENU_EDGE,
  });
  const nearBottom = menuPosition({ top: 640, bottom: 670, left: 400 }, menu, viewport);
  assert.equal(nearBottom.side, "above");
  assert.equal(nearBottom.top, 640 - MENU_GAP - menu.height);
  assert.ok(nearBottom.top >= MENU_EDGE);
});

test("the menu stays inside a small viewport", () => {
  const phone = { width: 360, height: 300 };
  const position = menuPosition({ top: 200, bottom: 230, left: 200 }, { width: 272, height: 240 }, phone);
  assert.equal(position.side, "above");
  assert.equal(position.left, 360 - MENU_EDGE - 272);
  assert.equal(position.maxHeight, 200 - MENU_GAP - MENU_EDGE);
  assert.equal(position.top, MENU_EDGE);
  assert.equal(menuPosition({ top: 10, bottom: 40, left: 2 }, { width: 272, height: 100 }, phone).left, MENU_EDGE);
});
