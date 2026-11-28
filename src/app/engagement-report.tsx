"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ConfirmRevision } from "./originality-report";
import { StopButton } from "./stop-button";
import {
  CURVE_LABEL,
  ENGAGEMENT_DIMENSION_LABELS,
  ENGAGEMENT_DIMENSIONS,
  ENGAGEMENT_DISCLAIMER,
  type EngagementRecommendation,
  type EngagementReport,
  type RecommendationAction,
  SCENE_FLAG_LABELS,
  type SceneAssessment,
  type SessionEngagement,
} from "@/lib/engagement";
import {
  analysedAtLabel,
  bandTone,
  type CurvePoint,
  curveGeometry,
  curveSummary,
  decidedFactsForAction,
  dimensionScoreLabel,
  ENGAGEMENT_COPY as COPY,
  groupRecommendations,
  isEditAction,
  metricsLabel,
  overallLabel,
  PRIORITY_LABELS,
  potentialLabel,
  RECOMMENDATION_ACTION_LABELS,
  recommendationActionHint,
  recommendationActions,
  sceneHeading,
  scenePotentialValue,
  scenesByIds,
  uniqueRefs,
} from "@/lib/engagement-ui";
import { isReportOutOfDate } from "@/lib/originality-ui";
import { STOPPED_MESSAGE } from "@/lib/request-stop";
import type { ContextFact, StoryContext } from "@/lib/story-context";
import type { ShotPlan } from "@/lib/story-planning";

export type EngagementPanelProps = {
  plan: ShotPlan | null;
  context: StoryContext | undefined;
  engagement: SessionEngagement | undefined;
  /** A request is running for this project; every action waits. */
  busy: boolean;
  /** Set while this project's analysis runs. */
  running: boolean;
  error: string;
  /** The last run was stopped by the filmmaker. */
  stopped: boolean;
  onRun: () => void;
  onStop: () => void;
  onClose: () => void;
  onAction: (action: RecommendationAction, recommendation: EngagementRecommendation) => void;
};

function formatDateTime(time: number): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function RefChips({ label, refs }: { label: string; refs: readonly string[] }) {
  const shown = uniqueRefs(refs);
  if (shown.length === 0) return null;
  return (
    <p className="orig-parts">
      <span className="orig-label">{label}</span>
      {shown.map((ref) => (
        <span className="orig-ref" key={ref}>
          {ref}
        </span>
      ))}
    </p>
  );
}

function LabelledList({ label, items }: { label: string; items: readonly string[] }) {
  const shown = items.map((item) => item.trim()).filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div className="eng-field">
      <p className="orig-label">{label}</p>
      <ul className="eng-list">
        {shown.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Items are fixed per report and may repeat.
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function LabelledText({ label, text, children }: { label: string; text: string; children?: ReactNode }) {
  if (!text.trim() && !children) return null;
  return (
    <div className="eng-field">
      <p className="orig-label">{label}</p>
      {text.trim() && <p>{text}</p>}
      {children}
    </div>
  );
}

function ScoreMeter({ score }: { score: number | null }) {
  if (score === null) return null;
  return (
    <span className="eng-meter" aria-hidden="true">
      <span className={`eng-meter-fill eng-band-${bandTone(score)}`} style={{ width: `${score}%` }} />
    </span>
  );
}

function PointMark({ point }: { point: CurvePoint & { y: number } }) {
  if (point.tone === "weakest") {
    const size = 6.5;
    return (
      <polygon
        className="eng-point eng-point-weakest"
        points={`${point.x},${point.y - size} ${point.x + size},${point.y} ${point.x},${point.y + size} ${point.x - size},${point.y}`}
      />
    );
  }
  return (
    <circle
      className={`eng-point${point.tone === "strongest" ? " eng-point-strongest" : ""}`}
      cx={point.x}
      cy={point.y}
      r={point.tone === "strongest" ? 6 : 4}
    />
  );
}

function EngagementCurve({ report }: { report: EngagementReport }) {
  const tableId = useId();
  const [showTable, setShowTable] = useState(false);
  const geometry = curveGeometry(report);
  const { plot } = geometry;
  const markerY = plot.top - 18;
  const notesByScene = (sceneId: string) =>
    report.curveNotes.flatMap((note, index) => (note.sceneId === sceneId ? [`${index + 1}. ${note.note}`] : []));

  if (geometry.points.length === 0) return <p className="muted">{COPY.noneListed}</p>;

  return (
    <figure className="eng-curve">
      <figcaption className="eng-curve-caption">{CURVE_LABEL}</figcaption>
      <svg
        className="eng-curve-svg"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-label={curveSummary(geometry.points)}
      >
        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            <line className="eng-grid" x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} />
            <text className="eng-axis" x={plot.left - 6} y={tick.y + 3.5} textAnchor="end">
              {tick.value}
            </text>
          </g>
        ))}
        {geometry.points
          .filter((point) => point.y === null)
          .map((point) => (
            <line key={point.sceneId} className="eng-gap" x1={point.x} x2={point.x} y1={plot.top} y2={plot.bottom} />
          ))}
        {geometry.markers.map((marker) => (
          <line
            key={marker.sceneId}
            className="eng-marker-guide"
            x1={marker.x}
            x2={marker.x}
            y1={markerY + 8}
            y2={marker.y ?? plot.bottom}
          />
        ))}
        {geometry.segments.map((path) => (
          <path key={path} className="eng-line" d={path} />
        ))}
        {geometry.points.map((point) =>
          point.y === null ? null : (
            <g key={point.sceneId}>
              <title>{`${sceneHeading(point)}: ${potentialLabel({ status: "ok", potential: point.value })}`}</title>
              <circle className="eng-hit" cx={point.x} cy={point.y} r={11} />
              <PointMark point={{ ...point, y: point.y }} />
              {point.labelY !== null && (
                <text className="eng-value" x={point.x} y={point.labelY} textAnchor="middle">
                  {point.value}
                </text>
              )}
            </g>
          ),
        )}
        {geometry.markers.map((marker) => {
          const width = 10 + marker.label.length * 6;
          return (
            <g key={marker.sceneId} className="eng-marker">
              <rect x={marker.x - width / 2} y={markerY - 8} width={width} height={16} rx={8} />
              <text x={marker.x} y={markerY + 4} textAnchor="middle">
                {marker.label}
              </text>
            </g>
          );
        })}
        {geometry.points.map((point) =>
          point.showLabel ? (
            <text key={point.sceneId} className="eng-axis" x={point.x} y={plot.bottom + 18} textAnchor="middle">
              {point.sceneId}
            </text>
          ) : null,
        )}
      </svg>
      <ul className="eng-legend">
        <li>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <circle className="eng-point eng-point-strongest" cx="7" cy="7" r="5" />
          </svg>
          {COPY.legendStrongest}
        </li>
        <li>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <polygon className="eng-point eng-point-weakest" points="7,1.5 12.5,7 7,12.5 1.5,7" />
          </svg>
          {COPY.legendWeakest}
        </li>
        <li>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <circle className="eng-point" cx="7" cy="7" r="3.5" />
          </svg>
          {COPY.legendOther}
        </li>
        {geometry.points.some((point) => point.y === null) && (
          <li>
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <line className="eng-gap" x1="7" x2="7" y1="0" y2="14" />
            </svg>
            {COPY.legendGap}
          </li>
        )}
      </ul>
      {report.curveNotes.length > 0 && (
        <div className="eng-field">
          <p className="orig-label">{COPY.curveNotesHeading}</p>
          <ol className="eng-notes">
            {report.curveNotes.map((note, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Notes are fixed per report and one scene may have several.
              <li key={index}>
                <span className="eng-note-num" aria-hidden="true">
                  {index + 1}
                </span>
                <span>
                  <span className="orig-ref">{note.sceneId}</span> {note.note}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <button
        className="orig-dismiss eng-table-toggle"
        type="button"
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((value) => !value)}
      >
        {showTable ? COPY.hideTable : COPY.showTable}
      </button>
      <div className="eng-table-wrap" id={tableId} hidden={!showTable}>
        <table className="eng-table">
          <caption className="sr-only">{CURVE_LABEL}</caption>
          <thead>
            <tr>
              <th className="eng-cell eng-head-cell" scope="col">
                {COPY.tableScene}
              </th>
              <th className="eng-cell eng-head-cell" scope="col">
                {COPY.tableTitle}
              </th>
              <th className="eng-cell eng-head-cell" scope="col">
                {COPY.tableScore}
              </th>
              <th className="eng-cell eng-head-cell" scope="col">
                {COPY.tableNote}
              </th>
            </tr>
          </thead>
          <tbody>
            {report.scenes.map((scene) => (
              <tr key={scene.sceneId}>
                <th className="eng-cell eng-row-head" scope="row">
                  {scene.sceneId}
                </th>
                <td className="eng-cell">{scene.title}</td>
                <td className="eng-cell">{potentialLabel(scene)}</td>
                <td className="eng-cell">{notesByScene(scene.sceneId).join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function SceneList({ heading, scenes }: { heading: string; scenes: readonly SceneAssessment[] }) {
  const headingId = useId();
  return (
    <section className="eng-scene-list" aria-labelledby={headingId}>
      <h5 className="orig-group-head" id={headingId}>
        {heading}
      </h5>
      {scenes.length === 0 ? (
        <p className="muted">{COPY.noneListed}</p>
      ) : (
        <ul>
          {scenes.map((scene) => (
            <li key={scene.sceneId}>
              <span className="orig-ref">{scene.sceneId}</span>
              <span className="eng-scene-name">{scene.title}</span>
              <span className={`eng-score eng-band-${bandTone(scenePotentialValue(scene))}`}>{potentialLabel(scene)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SceneDetails({ scene }: { scene: SceneAssessment }) {
  const failed = scene.status === "failed";
  return (
    <details className="eng-scene">
      <summary className="eng-scene-summary">
        <span className="eng-scene-title">{sceneHeading(scene)}</span>
        <span className={`eng-score eng-band-${bandTone(scenePotentialValue(scene))}`}>{potentialLabel(scene)}</span>
      </summary>
      <div className="eng-scene-body">
        {failed ? (
          <p className="orig-note-warning orig-note">{COPY.sceneFailed}</p>
        ) : (
          <>
            <LabelledText label={COPY.sceneSummary} text={scene.summary} />
            <LabelledText label={COPY.scenePurpose} text={scene.purpose} />
            <LabelledList label={COPY.sceneStrengths} items={scene.strengths} />
            <LabelledList label={COPY.sceneWeaknesses} items={scene.weaknesses} />
          </>
        )}
        <LabelledText label={COPY.scenePacing} text={failed ? "" : scene.pacing}>
          <p className="muted eng-metrics">{metricsLabel(scene.metrics)}</p>
        </LabelledText>
        {!failed && (
          <>
            <LabelledText label={COPY.sceneCuriosity} text={scene.curiosity} />
            <LabelledText label={COPY.sceneEmotion} text={scene.emotion} />
            {scene.flags.length > 0 && (
              <div className="eng-field">
                <p className="orig-label">{COPY.sceneFlags}</p>
                <ul className="eng-flags">
                  {scene.flags.map((flag) => (
                    <li key={flag} className="eng-flag">
                      {SCENE_FLAG_LABELS[flag]}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <LabelledList label={COPY.sceneImprovements} items={scene.improvements} />
            <LabelledText label={COPY.scenePotential} text={potentialLabel(scene)} />
            <RefChips label={COPY.sceneEvidence} refs={scene.evidence} />
          </>
        )}
      </div>
    </details>
  );
}

function RecommendationCard({
  recommendation,
  context,
  busy,
  stale,
  onAction,
}: {
  recommendation: EngagementRecommendation;
  context: StoryContext | undefined;
  busy: boolean;
  /** The plan changed since the analysis: scene refs may point at moved scenes, so edits wait for a re-run. */
  stale: boolean;
  onAction: (action: RecommendationAction, recommendation: EngagementRecommendation) => void;
}) {
  const problemId = useId();
  const [pending, setPending] = useState<{ action: RecommendationAction; facts: ContextFact[] } | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (wasConfirming.current && pending === null) editRef.current?.focus();
    wasConfirming.current = pending !== null;
  }, [pending]);

  function run(action: RecommendationAction) {
    const facts = decidedFactsForAction(context, action);
    if (facts.length > 0) setPending({ action, facts });
    else onAction(action, recommendation);
  }

  return (
    <li className="orig-finding">
      <article aria-labelledby={problemId}>
        <div className="orig-finding-meta">
          <span className={`orig-severity eng-priority-${recommendation.priority}`}>
            {PRIORITY_LABELS[recommendation.priority]}
            <span className="sr-only"> priority</span>
          </span>
        </div>
        <RefChips label={COPY.recScenes} refs={recommendation.sceneRefs} />
        <div className="eng-field">
          <p className="orig-label">{COPY.recProblem}</p>
          <p className="orig-finding-title" id={problemId}>
            {recommendation.problem}
          </p>
        </div>
        <LabelledText label={COPY.recWhy} text={recommendation.whyItMatters} />
        <p className="orig-suggestion">
          <span className="orig-label">{COPY.recAlternative}</span>
          {recommendation.alternative}
        </p>
        <LabelledText label={COPY.recBenefit} text={recommendation.benefit} />
        {pending ? (
          <ConfirmRevision
            facts={pending.facts}
            busy={busy}
            onContinue={() => {
              const { action } = pending;
              setPending(null);
              onAction(action, recommendation);
            }}
            onCancel={() => setPending(null)}
          />
        ) : (
          <div className="orig-actions">
            {recommendationActions(recommendation).map((action) => (
              <button
                key={action}
                ref={isEditAction(action) ? editRef : undefined}
                className="button secondary"
                type="button"
                disabled={busy || (stale && isEditAction(action))}
                title={stale && isEditAction(action) ? COPY.staleEdit : recommendationActionHint(action)}
                onClick={() => run(action)}
              >
                {RECOMMENDATION_ACTION_LABELS[action]}
              </button>
            ))}
            {stale && <p className="orig-basis">{COPY.staleEdit}</p>}
          </div>
        )}
      </article>
    </li>
  );
}

function ReportView({
  report,
  plan,
  context,
  busy,
  onRun,
  onAction,
}: {
  report: EngagementReport;
  plan: ShotPlan | null;
  context: StoryContext | undefined;
  busy: boolean;
  onRun: () => void;
  onAction: (action: RecommendationAction, recommendation: EngagementRecommendation) => void;
}) {
  const ids = useId();
  const analysedAt = formatDateTime(report.createdAt);
  const keyFactors = report.keyFactors.map((item) => item.trim()).filter(Boolean);
  const dimensions = ENGAGEMENT_DIMENSIONS.flatMap((dimension) => report.dimensions.filter((item) => item.dimension === dimension));
  const groups = groupRecommendations(report.recommendations);

  return (
    <div className="orig-report">
      <div className="orig-meta">
        {analysedAt && <p className="muted orig-date">{analysedAtLabel(analysedAt)}</p>}
        {isReportOutOfDate(plan, report) && <p className="orig-stale">{COPY.outOfDate}</p>}
        <button className="button secondary eng-rerun" type="button" disabled={busy} onClick={onRun}>
          {COPY.rerun}
        </button>
      </div>

      <section className="eng-overall" aria-labelledby={`${ids}-overall`}>
        <h4 className="orig-label" id={`${ids}-overall`}>
          {COPY.overallHeading}
        </h4>
        <p className="eng-overall-score">{overallLabel(report.overall.score)}</p>
        <ScoreMeter score={report.overall.score} />
        {report.overall.summary.trim() && <p>{report.overall.summary}</p>}
        <LabelledList label={COPY.keyFactors} items={keyFactors} />
      </section>

      <section className="orig-section" aria-labelledby={`${ids}-dimensions`}>
        <h4 className="orig-section-head" id={`${ids}-dimensions`}>
          {COPY.dimensionsHeading}
        </h4>
        <ul className="eng-dimensions">
          {dimensions.map((item) => {
            const score = item.insufficient ? null : item.score;
            return (
              <li key={item.dimension} className="eng-card">
                <h5 className="eng-card-title">{ENGAGEMENT_DIMENSION_LABELS[item.dimension]}</h5>
                <p className={`eng-score eng-band-${bandTone(score)}`}>{dimensionScoreLabel(item)}</p>
                <ScoreMeter score={score} />
                {item.explanation.trim() && <p className="eng-card-text">{item.explanation}</p>}
                <RefChips label={COPY.basedOn} refs={item.evidence} />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="orig-section" aria-labelledby={`${ids}-curve`}>
        <h4 className="orig-section-head" id={`${ids}-curve`}>
          {COPY.curveHeading}
        </h4>
        <EngagementCurve report={report} />
        <div className="eng-columns">
          <SceneList heading={COPY.strongestHeading} scenes={scenesByIds(report.scenes, report.strongest)} />
          <SceneList heading={COPY.weakestHeading} scenes={scenesByIds(report.scenes, report.weakest)} />
        </div>
      </section>

      {report.scenes.length > 0 && (
        <section className="orig-section" aria-labelledby={`${ids}-scenes`}>
          <h4 className="orig-section-head" id={`${ids}-scenes`}>
            {COPY.scenesHeading}
          </h4>
          <ol className="eng-scenes">
            {report.scenes.map((scene) => (
              <li key={scene.sceneId}>
                <SceneDetails scene={scene} />
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="orig-section" aria-labelledby={`${ids}-recommendations`}>
        <h4 className="orig-section-head" id={`${ids}-recommendations`}>
          {COPY.recommendationsHeading}
        </h4>
        {groups.length === 0 && <p className="muted">{COPY.noRecommendations}</p>}
        {groups.map((group) => (
          <section className="orig-group" key={group.priority} aria-labelledby={`${ids}-${group.priority}`}>
            <h5 className="orig-group-head" id={`${ids}-${group.priority}`}>
              {PRIORITY_LABELS[group.priority]} ({group.recommendations.length})
            </h5>
            <ul className="orig-findings">
              {group.recommendations.map((recommendation) => (
                <RecommendationCard
                  key={recommendation.id}
                  recommendation={recommendation}
                  context={context}
                  busy={busy}
                  stale={isReportOutOfDate(plan, report)}
                  onAction={onAction}
                />
              ))}
            </ul>
          </section>
        ))}
      </section>
    </div>
  );
}

export function EngagementPanel({
  plan,
  context,
  engagement,
  busy,
  running,
  error,
  stopped,
  onRun,
  onStop,
  onClose,
  onAction,
}: EngagementPanelProps) {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const report = engagement?.report;
  const [finished, setFinished] = useState(false);
  const wasRunning = useRef(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    setFinished(wasRunning.current && !running);
    wasRunning.current = running;
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

  return (
    <section className="engagement-panel panel" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="orig-head">
        <div className="eng-head-text">
          <h3 className="orig-title" id={titleId} ref={headingRef} tabIndex={-1}>
            {COPY.panelTitle}
          </h3>
          <p className="muted eng-subtitle">{COPY.subtitle}</p>
        </div>
        <button className="button secondary orig-close" type="button" onClick={onClose}>
          {COPY.close}
        </button>
      </div>
      <div className="orig-body">
        <div className={running ? "stop-row" : "stop-row-idle"}>
          <p className={running || stopped ? "muted orig-running" : "sr-only"} role="status">
            {running ? COPY.running : stopped ? STOPPED_MESSAGE : finished && !error ? COPY.finished : ""}
          </p>
          {running && <StopButton onStop={stop} />}
        </div>
        {error && !running && (
          <div className="orig-error" role="alert">
            <p className="error">{error}</p>
            <button className="button secondary" type="button" disabled={busy} onClick={onRun}>
              {COPY.retry}
            </button>
          </div>
        )}
        {report ? (
          <ReportView report={report} plan={plan} context={context} busy={busy} onRun={onRun} onAction={onAction} />
        ) : (
          !running &&
          !error && (
            <div className="orig-run">
              <div className="orig-run-row">
                <button className="button orig-run-btn" type="button" disabled={busy} onClick={onRun}>
                  {COPY.run}
                </button>
              </div>
            </div>
          )
        )}
        <p className="orig-disclaimer">{ENGAGEMENT_DISCLAIMER}</p>
      </div>
    </section>
  );
}
