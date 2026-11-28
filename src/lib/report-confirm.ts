import type { ReportId } from "@/lib/quick-actions";
import type { StorySession } from "@/lib/session";

export type ReportConfirmOption = { label: string; note: string };
export type ReportConfirmCopy = { title: string; text: string; option?: ReportConfirmOption };

export const REPORT_CONFIRM_LABELS = {
  accept: "Accept",
  close: "Close",
  busy: "You can start this once the current request finishes.",
} as const;

export const REPORT_CONFIRM_COPY: Record<ReportId, ReportConfirmCopy> = {
  originality: {
    title: "Check story originality",
    text: "We’ll compare your plan with existing films, books and shows and flag anything that may be too close. Nothing in your story changes.",
    option: {
      label: "Also check published works on Wikipedia",
      note: "Only work titles are sent, never your story.",
    },
  },
  engagement: {
    title: "Check how well your story holds attention",
    text: "We’ll rate how well each scene could hold attention and suggest fixes. It’s an AI estimate, not real audience data. Nothing in your story changes. Takes about 30–40 seconds.",
  },
};

export type ReportEntry = "confirm" | "panel";

/** A report that exists or is already running opens directly; a first run is confirmed in a dialog. */
export function reportEntry(
  id: ReportId,
  session: Pick<StorySession, "originality" | "engagement">,
  running: boolean,
): ReportEntry {
  const report = id === "originality" ? session.originality?.report : session.engagement?.report;
  return report || running ? "panel" : "confirm";
}

export type ReportRunners = { originality: (references: boolean) => void; engagement: () => void };

/** Starts the confirmed report's existing run handler; only the originality check takes the Wikipedia choice. */
export function runConfirmedReport(id: ReportId, references: boolean, runners: ReportRunners): void {
  if (id === "originality") runners.originality(references);
  else runners.engagement();
}
