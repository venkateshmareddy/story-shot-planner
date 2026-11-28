import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EngagementPanel } from "../src/app/engagement-report.tsx";
import { OriginalityPanel } from "../src/app/originality-report.tsx";
import { ReportConfirmContent, type ReportConfirmContentProps, ReportConfirmDialog } from "../src/app/report-confirm-dialog.tsx";
import { ENGAGEMENT_COPY } from "../src/lib/engagement-ui.ts";
import { ORIGINALITY_COPY } from "../src/lib/originality-ui.ts";
import type { ReportId } from "../src/lib/quick-actions.ts";
import {
  REPORT_CONFIRM_COPY,
  REPORT_CONFIRM_LABELS,
  reportEntry,
  runConfirmedReport,
} from "../src/lib/report-confirm.ts";
import type { StorySession } from "../src/lib/session.ts";
import type { ShotPlan } from "../src/lib/story-planning.ts";

const plan: ShotPlan = { title: "T", logline: "", intent: "", characters: [], locations: [], scenes: [], reviewNotes: [] };
const noop = () => {};
const ids = { title: "c-title", text: "c-text", option: "c-option", note: "c-note" };

type Element = ReactElement<Record<string, unknown>>;

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}

function renderContent(overrides: Partial<ReportConfirmContentProps> = {}) {
  const calls = { accept: [] as boolean[], option: [] as boolean[], close: 0 };
  const tree = ReportConfirmContent({
    copy: REPORT_CONFIRM_COPY.originality,
    ids,
    busy: false,
    option: true,
    onOption: (value) => calls.option.push(value),
    onAccept: (value) => calls.accept.push(value),
    onClose: () => {
      calls.close += 1;
    },
    ...overrides,
  });
  const nodes = elements(tree);
  const button = (label: string) => {
    const found = nodes.find((node) => node.type === "button" && node.props.children === label);
    assert.ok(found, `${label} button is rendered`);
    return found.props as { onClick: () => void; disabled?: boolean; className: string };
  };
  const checkbox = nodes.find((node) => node.type === "input" && node.props.type === "checkbox");
  return { calls, nodes, button, checkbox };
}

test("confirm dialog copy is short and plain", () => {
  assert.deepEqual(REPORT_CONFIRM_LABELS, {
    accept: "Accept",
    close: "Close",
    busy: "You can start this once the current request finishes.",
  });
  assert.deepEqual(REPORT_CONFIRM_COPY.originality, {
    title: "Check story originality",
    text: "We’ll compare your plan with existing films, books and shows and flag anything that may be too close. Nothing in your story changes.",
    option: {
      label: "Also check published works on Wikipedia",
      note: "Only work titles are sent, never your story.",
    },
  });
  assert.deepEqual(REPORT_CONFIRM_COPY.engagement, {
    title: "Check how well your story holds attention",
    text: "We’ll rate how well each scene could hold attention and suggest fixes. It’s an AI estimate, not real audience data. Nothing in your story changes. Takes about 30–40 seconds.",
  });
});

test("the button opens the confirm dialog for a first run and the report panel otherwise", () => {
  const empty: Pick<StorySession, "originality" | "engagement"> = {};
  const withReports = {
    originality: { report: {}, dismissed: [] },
    engagement: { report: {} },
  } as unknown as Pick<StorySession, "originality" | "engagement">;
  for (const id of ["originality", "engagement"] as const satisfies readonly ReportId[]) {
    assert.equal(reportEntry(id, empty, false), "confirm", `${id}: no report`);
    assert.equal(reportEntry(id, withReports, false), "panel", `${id}: report exists`);
    assert.equal(reportEntry(id, empty, true), "panel", `${id}: a first run is in progress`);
  }
  assert.equal(reportEntry("engagement", { originality: withReports.originality }, false), "confirm");
  assert.equal(reportEntry("originality", { engagement: withReports.engagement }, false), "confirm");
});

test("a confirmed report starts its own run handler with the Wikipedia choice", () => {
  const runs: string[] = [];
  const runners = {
    originality: (references: boolean) => runs.push(`originality:${references}`),
    engagement: () => runs.push("engagement"),
  };
  runConfirmedReport("originality", false, runners);
  runConfirmedReport("originality", true, runners);
  runConfirmedReport("engagement", true, runners);
  assert.deepEqual(runs, ["originality:false", "originality:true", "engagement"]);
});

test("Accept passes the checkbox value; Close never runs", () => {
  const checked = renderContent();
  checked.button("Accept").onClick();
  assert.deepEqual(checked.calls.accept, [true]);

  const unchecked = renderContent({ option: false });
  unchecked.button("Accept").onClick();
  assert.deepEqual(unchecked.calls.accept, [false]);

  const closed = renderContent();
  closed.button("Close").onClick();
  assert.equal(closed.calls.close, 1);
  assert.deepEqual(closed.calls.accept, []);
});

test("the Wikipedia checkbox reports its new value and is described by the privacy note", () => {
  const { checkbox, calls } = renderContent();
  assert.ok(checkbox);
  assert.equal(checkbox.props.checked, true);
  assert.equal(checkbox.props["aria-describedby"], ids.note);
  (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } });
  assert.deepEqual(calls.option, [false]);
});

test("Accept waits while a request runs, with a note saying why; Close stays available", () => {
  const { button, nodes } = renderContent({ busy: true });
  assert.equal(button("Accept").disabled, true);
  assert.notEqual(button("Close").disabled, true);
  assert.ok(nodes.some((node) => node.props.role === "status" && node.props.children === REPORT_CONFIRM_LABELS.busy));
});

test("the attention dialog has no checkbox", () => {
  const { checkbox, button, calls } = renderContent({ copy: REPORT_CONFIRM_COPY.engagement });
  assert.equal(checkbox, undefined);
  button("Accept").onClick();
  assert.equal(calls.accept.length, 1);
});

test("the dialog renders closed until opened, labelled by its title, with Close before Accept", () => {
  const render = (option?: boolean) =>
    renderToStaticMarkup(
      createElement(ReportConfirmDialog, {
        copy: REPORT_CONFIRM_COPY.originality,
        busy: false,
        option,
        onAccept: noop,
        onClose: noop,
      }),
    );
  const html = render();
  const dialog = html.match(/<dialog([^>]*)>/)?.[1] ?? "";
  assert.match(dialog, /class="report-confirm"/);
  assert.doesNotMatch(dialog, /\sopen/);
  const labelledBy = dialog.match(/aria-labelledby="([^"]+)"/)?.[1];
  const describedBy = dialog.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(labelledBy && html.includes(`<h2 class="report-confirm-title" id="${labelledBy}">Check story originality</h2>`));
  assert.ok(describedBy && html.includes(`id="${describedBy}">We’ll compare your plan`));
  assert.match(html, /<input[^>]*type="checkbox"[^>]*checked=""/, "Wikipedia lookup is on by default");
  assert.doesNotMatch(render(false), /checked=""/, "the last choice is kept");
  assert.deepEqual(
    [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(([, label]) => label),
    ["Close", "Accept"],
  );
});

function originalityPanel(overrides: Partial<Parameters<typeof OriginalityPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(OriginalityPanel, {
      plan,
      context: undefined,
      originality: undefined,
      defaultReferences: true,
      busy: false,
      running: null,
      error: "",
      stopped: false,
      onRun: noop,
      onStop: noop,
      onClose: noop,
      onAction: noop,
      onDismiss: noop,
      onRestore: noop,
      ...overrides,
    }),
  );
}

function engagementPanel(overrides: Partial<Parameters<typeof EngagementPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(EngagementPanel, {
      plan,
      context: undefined,
      engagement: undefined,
      busy: false,
      running: false,
      error: "",
      stopped: false,
      onRun: noop,
      onStop: noop,
      onClose: noop,
      onAction: noop,
      ...overrides,
    }),
  );
}

test("the originality panel has no long pre-run intro; it shows the run state or a plain run fallback", () => {
  const running = originalityPanel({ busy: true, running: { references: true } });
  assert.match(running, new RegExp(ORIGINALITY_COPY.runningWithReferences.slice(0, 30)));
  assert.doesNotMatch(running, new RegExp(`>${ORIGINALITY_COPY.run}<`));
  assert.doesNotMatch(running, /points out parts|You decide what to do with each finding/);

  const stopped = originalityPanel({ stopped: true, defaultReferences: false });
  assert.match(stopped, new RegExp(`>${ORIGINALITY_COPY.run}<`), "after a stop the check can be run again");
  assert.doesNotMatch(stopped, /<input[^>]*type="checkbox"[^>]*checked=""/, "keeps the Wikipedia choice from the dialog");

  const failed = originalityPanel({ error: "Something went wrong." });
  assert.match(failed, new RegExp(`>${ORIGINALITY_COPY.retry}<`));
  assert.doesNotMatch(failed, new RegExp(`>${ORIGINALITY_COPY.run}<`));
});

test("the attention panel has no long pre-run intro; it shows the run state or a plain run fallback", () => {
  const running = engagementPanel({ busy: true, running: true });
  assert.match(running, new RegExp(ENGAGEMENT_COPY.running.slice(0, 30)));
  assert.doesNotMatch(running, new RegExp(`>${ENGAGEMENT_COPY.run}<`));
  assert.doesNotMatch(running, /scene by scene and estimates/);

  assert.match(engagementPanel({ stopped: true }), new RegExp(`>${ENGAGEMENT_COPY.run}<`));
  const failed = engagementPanel({ error: "Something went wrong." });
  assert.match(failed, new RegExp(`>${ENGAGEMENT_COPY.retry}<`));
  assert.doesNotMatch(failed, new RegExp(`>${ENGAGEMENT_COPY.run}<`));
});
