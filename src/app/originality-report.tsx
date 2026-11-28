"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { StopButton } from "./stop-button";
import {
  DIMENSION_LABELS,
  ORIGINALITY_DIMENSIONS,
  ORIGINALITY_DISCLAIMER,
  type OriginalityFinding,
  type OriginalityReport,
  type ReferenceWork,
  SEVERITY_DEFINITIONS,
  type SessionOriginality,
} from "@/lib/originality";
import {
  checkedAtLabel,
  decidedFactsFor,
  dismissedHeading,
  FINDING_ACTION_HINTS,
  FINDING_ACTION_LABELS,
  type FindingAction,
  findingReference,
  isReportOutOfDate,
  lookupNote,
  modeLabel,
  moreLabel,
  ORIGINALITY_COPY as COPY,
  overallStatus,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  safeSourceUrl,
  splitFindings,
} from "@/lib/originality-ui";
import { STOPPED_MESSAGE } from "@/lib/request-stop";
import type { ContextFact, StoryContext } from "@/lib/story-context";
import type { ShotPlan } from "@/lib/story-planning";

const MAX_CONFIRM_FACTS = 6;
const MAX_CONFIRM_VALUE = 140;

export type OriginalityPanelProps = {
  plan: ShotPlan | null;
  context: StoryContext | undefined;
  originality: SessionOriginality | undefined;
  /** The Wikipedia choice to start from when there is no report yet. */
  defaultReferences: boolean;
  /** A request is running for this project; every action waits. */
  busy: boolean;
  /** Set while this project's originality check runs. */
  running: { references: boolean } | null;
  error: string;
  /** The last run was stopped by the filmmaker. */
  stopped: boolean;
  onRun: (references: boolean) => void;
  onStop: () => void;
  onClose: () => void;
  onAction: (action: FindingAction, finding: OriginalityFinding) => void;
  onDismiss: (finding: OriginalityFinding) => void;
  onRestore: (finding: OriginalityFinding) => void;
};

function formatDateTime(time: number): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function clipValue(text: string): string {
  return text.length > MAX_CONFIRM_VALUE ? `${text.slice(0, MAX_CONFIRM_VALUE - 1).trimEnd()}…` : text;
}

function RunControls({
  label,
  references,
  busy,
  onReferences,
  onRun,
}: {
  label: string;
  references: boolean;
  busy: boolean;
  onReferences: (value: boolean) => void;
  onRun: () => void;
}) {
  const checkboxId = useId();
  const disclosureId = useId();
  return (
    <div className="orig-run">
      <div className="orig-run-row">
        <label className="orig-check" htmlFor={checkboxId}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={references}
            disabled={busy}
            aria-describedby={disclosureId}
            onChange={(event) => onReferences(event.target.checked)}
          />
          {COPY.referencesLabel}
        </label>
        <button className="button orig-run-btn" type="button" disabled={busy} onClick={onRun}>
          {label}
        </button>
      </div>
      <p className="muted orig-disclosure" id={disclosureId}>
        {COPY.referencesDisclosure}
      </p>
    </div>
  );
}

function SourceBox({ reference, evidence }: { reference: ReferenceWork; evidence: string }) {
  const href = safeSourceUrl(reference.url);
  const retrieved = formatDate(reference.retrievedAt);
  const quote = evidence.trim() || reference.excerpt.trim();
  return (
    <div className="orig-source">
      <p className="orig-label">{COPY.verifiedSource}</p>
      <p className="orig-source-title">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {reference.title}
            <span className="sr-only"> {COPY.opensInNewTab}</span>
          </a>
        ) : (
          reference.title
        )}
      </p>
      {reference.description && <p className="muted orig-source-desc">{reference.description}</p>}
      {quote && <blockquote className="orig-evidence">“{quote}”</blockquote>}
      <p className="muted orig-source-meta">
        {retrieved && `${COPY.retrieved} ${retrieved} · `}
        {COPY.sourceAttribution}
      </p>
    </div>
  );
}

export function ConfirmRevision({
  facts,
  busy,
  onContinue,
  onCancel,
}: {
  facts: ContextFact[];
  busy: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const boxRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    boxRef.current?.focus();
  }, []);
  const shown = facts.slice(0, MAX_CONFIRM_FACTS);
  return (
    <fieldset className="orig-confirm" ref={boxRef} tabIndex={-1}>
      <legend className="orig-confirm-head">{COPY.confirmChange}</legend>
      <ul className="orig-confirm-list">
        {shown.map((fact) => (
          <li key={`${fact.category}:${fact.label}`}>
            <strong>{fact.label}:</strong> {clipValue(fact.value)}
          </li>
        ))}
      </ul>
      {facts.length > shown.length && <p className="muted orig-more">{moreLabel(facts.length - shown.length)}</p>}
      <p className="orig-confirm-question">{COPY.confirmQuestion}</p>
      <div className="orig-actions">
        <button className="button" type="button" disabled={busy} onClick={onContinue}>
          {COPY.confirmContinue}
        </button>
        <button className="button secondary" type="button" onClick={onCancel}>
          {COPY.cancel}
        </button>
      </div>
    </fieldset>
  );
}

function FindingCard({
  finding,
  reference,
  context,
  busy,
  stale,
  onAction,
  onDismiss,
}: {
  finding: OriginalityFinding;
  reference: ReferenceWork | null;
  context: StoryContext | undefined;
  busy: boolean;
  /** The plan changed since the check: story refs may point at moved scenes, so revising waits for a re-check. */
  stale: boolean;
  onAction: (action: FindingAction, finding: OriginalityFinding) => void;
  onDismiss: (finding: OriginalityFinding) => void;
}) {
  const titleId = useId();
  const [decided, setDecided] = useState<ContextFact[] | null>(null);
  const reviseRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const refs = [...new Set(finding.storyRefs.map((ref) => ref.trim()).filter(Boolean))];

  useEffect(() => {
    if (wasConfirming.current && decided === null) reviseRef.current?.focus();
    wasConfirming.current = decided !== null;
  }, [decided]);

  function revise() {
    const facts = decidedFactsFor(context, finding.dimension);
    if (facts.length > 0) setDecided(facts);
    else onAction("revise", finding);
  }

  return (
    <li className="orig-finding">
      <article aria-labelledby={titleId}>
        <div className="orig-finding-meta">
          <span className="orig-dimension">{DIMENSION_LABELS[finding.dimension]}</span>
          <span className={`orig-severity orig-severity-${finding.severity}`}>
            {SEVERITY_LABELS[finding.severity]}
            <span className="sr-only"> level</span>
          </span>
        </div>
        <h6 className="orig-finding-title" id={titleId}>
          {finding.title}
        </h6>
        <p className="orig-finding-text">{finding.explanation}</p>
        {refs.length > 0 && (
          <p className="orig-parts">
            <span className="orig-label">{COPY.storyParts}</span>
            {refs.map((ref) => (
              <span className="orig-ref" key={ref}>
                {ref}
              </span>
            ))}
          </p>
        )}
        {finding.storyExcerpt && (
          <figure className="orig-excerpt">
            <figcaption className="orig-label">{COPY.fromYourStory}</figcaption>
            <blockquote>{finding.storyExcerpt}</blockquote>
          </figure>
        )}
        <p className="orig-suggestion">
          <span className="orig-label">{COPY.suggestion}</span>
          {finding.suggestion}
        </p>
        {reference ? (
          <SourceBox reference={reference} evidence={finding.referenceEvidence} />
        ) : (
          <p className="orig-basis">{COPY.aiIdentified}</p>
        )}
        {decided ? (
          <ConfirmRevision
            facts={decided}
            busy={busy}
            onContinue={() => {
              setDecided(null);
              onAction("revise", finding);
            }}
            onCancel={() => setDecided(null)}
          />
        ) : (
          <div className="orig-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              title={FINDING_ACTION_HINTS.discuss}
              onClick={() => onAction("discuss", finding)}
            >
              {FINDING_ACTION_LABELS.discuss}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              title={FINDING_ACTION_HINTS.alternatives}
              onClick={() => onAction("alternatives", finding)}
            >
              {FINDING_ACTION_LABELS.alternatives}
            </button>
            <button
              ref={reviseRef}
              className="button secondary"
              type="button"
              disabled={busy || stale}
              title={stale ? COPY.staleEdit : FINDING_ACTION_HINTS.revise}
              onClick={revise}
            >
              {FINDING_ACTION_LABELS.revise}
            </button>
            <button
              className="orig-dismiss"
              type="button"
              disabled={busy}
              aria-label={`${COPY.dismiss}: ${finding.title}`}
              onClick={() => onDismiss(finding)}
            >
              {COPY.dismiss}
            </button>
          {stale && <p className="orig-basis">{COPY.staleEdit}</p>}
          </div>
        )}
      </article>
    </li>
  );
}

function ReportView({
  report,
  dismissed,
  plan,
  context,
  busy,
  runControls,
  onAction,
  onDismiss,
  onRestore,
}: {
  report: OriginalityReport;
  dismissed: readonly string[];
  plan: ShotPlan | null;
  context: StoryContext | undefined;
  busy: boolean;
  runControls: ReactNode;
  onAction: (action: FindingAction, finding: OriginalityFinding) => void;
  onDismiss: (finding: OriginalityFinding) => void;
  onRestore: (finding: OriginalityFinding) => void;
}) {
  const ids = useId();
  const summaryRef = useRef<HTMLElement>(null);
  const focusDismissed = useRef(false);
  const note = lookupNote(report);
  const status = overallStatus(report, dismissed);
  const { groups, dismissed: hiddenFindings } = splitFindings(report.findings, dismissed);
  const checkedAt = formatDateTime(report.createdAt);

  useEffect(() => {
    if (!focusDismissed.current) return;
    focusDismissed.current = false;
    summaryRef.current?.focus();
  });

  function dismiss(finding: OriginalityFinding) {
    focusDismissed.current = true;
    onDismiss(finding);
  }

  return (
    <div className="orig-report">
      <div className="orig-meta">
        <p className="orig-mode">{modeLabel(report)}</p>
        {checkedAt && <p className="muted orig-date">{checkedAtLabel(checkedAt)}</p>}
        {isReportOutOfDate(plan, report) && <p className="orig-stale">{COPY.outOfDate}</p>}
      </div>
      {note && <p className={note.warning ? "orig-note orig-note-warning" : "muted orig-note"}>{note.text}</p>}
      {runControls}

      <div className={`orig-status orig-status-${status.tone}`}>
        <p className="orig-label">{COPY.overall}</p>
        <p>{status.text}</p>
      </div>

      <section className="orig-section" aria-labelledby={`${ids}-coverage`}>
        <h4 className="orig-section-head" id={`${ids}-coverage`}>
          {COPY.coverageHeading}
        </h4>
        <ul className="orig-coverage">
          {ORIGINALITY_DIMENSIONS.map((dimension) => {
            const checked = report.coverage[dimension] === "checked";
            return (
              <li key={dimension} className={`orig-chip${checked ? " orig-chip-checked" : ""}`}>
                {DIMENSION_LABELS[dimension]}: {checked ? COPY.checked : COPY.notAvailable}
              </li>
            );
          })}
        </ul>
      </section>

      {report.tropes.length > 0 && (
        <section className="orig-section" aria-labelledby={`${ids}-tropes`}>
          <h4 className="orig-section-head" id={`${ids}-tropes`}>
            {COPY.tropesHeading}
          </h4>
          <p className="muted orig-section-intro">{COPY.tropesIntro}</p>
          <ul className="orig-tropes">
            {report.tropes.map((trope, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Tropes are fixed per report and may repeat.
              <li key={index}>
                <strong>{trope.title}</strong>
                {trope.note && <span className="muted"> — {trope.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.length > 0 && (
        <section className="orig-section" aria-labelledby={`${ids}-findings`}>
          <h4 className="orig-section-head" id={`${ids}-findings`}>
            {COPY.findingsHeading}
          </h4>
          <details className="orig-legend" open>
            <summary>{COPY.legendHeading}</summary>
            <dl>
              {SEVERITY_ORDER.map((severity) => (
                <div key={severity}>
                  <dt>
                    <span className={`orig-severity orig-severity-${severity}`}>{SEVERITY_LABELS[severity]}</span>
                  </dt>
                  <dd>{SEVERITY_DEFINITIONS[severity]}</dd>
                </div>
              ))}
            </dl>
          </details>
          {groups.map((group) => (
            <section className="orig-group" key={group.severity} aria-labelledby={`${ids}-${group.severity}`}>
              <h5 className="orig-group-head" id={`${ids}-${group.severity}`}>
                {SEVERITY_LABELS[group.severity]} ({group.findings.length})
              </h5>
              <ul className="orig-findings">
                {group.findings.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    reference={findingReference(finding, report.references)}
                    context={context}
                    busy={busy}
                    stale={isReportOutOfDate(plan, report)}
                    onAction={onAction}
                    onDismiss={dismiss}
                  />
                ))}
              </ul>
            </section>
          ))}
        </section>
      )}

      {hiddenFindings.length > 0 && (
        <details className="orig-dismissed">
          <summary ref={summaryRef}>{dismissedHeading(hiddenFindings.length)}</summary>
          <p className="muted orig-section-intro">{COPY.dismissedHint}</p>
          <ul>
            {hiddenFindings.map((finding) => (
              <li key={finding.id}>
                <span>
                  {finding.title}
                  <span className="muted"> · {DIMENSION_LABELS[finding.dimension]}</span>
                </span>
                <button
                  className="orig-dismiss"
                  type="button"
                  disabled={busy}
                  aria-label={`${COPY.undo}: ${finding.title}`}
                  onClick={() => onRestore(finding)}
                >
                  {COPY.undo}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="orig-disclaimer">{ORIGINALITY_DISCLAIMER}</p>
    </div>
  );
}

export function OriginalityPanel({
  plan,
  context,
  originality,
  defaultReferences,
  busy,
  running,
  error,
  stopped,
  onRun,
  onStop,
  onClose,
  onAction,
  onDismiss,
  onRestore,
}: OriginalityPanelProps) {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const report = originality?.report;
  const [references, setReferences] = useState(report?.referenceLookup.requested ?? defaultReferences);
  const [finished, setFinished] = useState(false);
  const wasRunning = useRef(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    setFinished(wasRunning.current && !running);
    wasRunning.current = running !== null;
  }, [running]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  }

  function stop() {
    onStop();
    headingRef.current?.focus();
  }

  const runControls = (
    <RunControls
      label={report ? COPY.recheck : COPY.run}
      references={references}
      busy={busy}
      onReferences={setReferences}
      onRun={() => onRun(references)}
    />
  );

  return (
    <section className="originality-panel panel" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="orig-head">
        <h3 className="orig-title" id={titleId} ref={headingRef} tabIndex={-1}>
          {COPY.panelTitle}
        </h3>
        <button className="button secondary orig-close" type="button" onClick={onClose}>
          {COPY.close}
        </button>
      </div>
      <div className="orig-body">
        <div className={running ? "stop-row" : "stop-row-idle"}>
          <p className={running || stopped ? "muted orig-running" : "sr-only"} role="status">
            {running
              ? running.references
                ? COPY.runningWithReferences
                : COPY.running
              : stopped
                ? STOPPED_MESSAGE
                : finished && !error
                  ? COPY.finished
                  : ""}
          </p>
          {running && <StopButton onStop={stop} />}
        </div>
        {error && !running && (
          <div className="orig-error" role="alert">
            <p className="error">{error}</p>
            <button className="button secondary" type="button" disabled={busy} onClick={() => onRun(references)}>
              {COPY.retry}
            </button>
          </div>
        )}
        {report ? (
          <ReportView
            report={report}
            dismissed={originality?.dismissed ?? []}
            plan={plan}
            context={context}
            busy={busy}
            runControls={runControls}
            onAction={onAction}
            onDismiss={onDismiss}
            onRestore={onRestore}
          />
        ) : (
          <div className="orig-intro">
            {!running && !error && runControls}
            <p className="orig-disclaimer">{ORIGINALITY_DISCLAIMER}</p>
          </div>
        )}
      </div>
    </section>
  );
}
