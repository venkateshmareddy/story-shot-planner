import {
  type ContextFact,
  categoryOf,
  MAX_FACT_VALUE,
  mergeFacts,
  type StoryContext,
  sameFactValue,
  VISUAL_CATEGORY,
  type VisualEntity,
  type VisualKind,
  type VisualStatus,
  visualFactKey,
  visualLabel,
  visualStatus,
} from "./story-context";

export type LookRow = { entity: VisualEntity; status: VisualStatus; fact?: ContextFact };

const KIND_ORDER: Record<VisualKind, number> = { conditions: 0, place: 1, object: 2, character: 3 };

export const LOOK_KIND_LABELS: Record<VisualKind, string> = {
  conditions: "Time & weather",
  place: "Place",
  object: "Object",
  character: "Character",
};

export const LOOK_STATUS_LABELS: Record<VisualStatus, string> = {
  confirmed: "From you",
  ai: "AI suggestion",
  open: "Open",
  skipped: "Skipped",
};

export const LOOK_OPEN_TEXT = "Not described yet";
export const LOOK_SKIPPED_TEXT = "Skipped — the AI will choose a look";

/** Key things and things that already have a look: conditions, places, objects, characters, then first mention. */
export function lookRows(context: StoryContext): LookRow[] {
  const seen = new Set<string>();
  return (context.visuals ?? [])
    .flatMap((entity, index) => {
      const key = visualFactKey(entity);
      if (seen.has(key)) return [];
      seen.add(key);
      const { status, fact } = visualStatus(context, entity);
      if (!entity.key && !fact) return [];
      return [{ index, row: fact ? { entity, status, fact } : { entity, status } }];
    })
    .sort((a, b) => KIND_ORDER[a.row.entity.kind] - KIND_ORDER[b.row.entity.kind] || a.index - b.index)
    .map(({ row }) => row);
}

export function lookValue(row: LookRow): string {
  if (row.fact) return row.fact.value;
  return row.status === "skipped" ? LOOK_SKIPPED_TEXT : LOOK_OPEN_TEXT;
}

export function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function openLooksLine(rows: LookRow[]): string | null {
  const names = rows.filter((row) => row.entity.key && row.status === "open").map((row) => row.entity.name.trim());
  return names.length > 0 ? `Looks still open: ${joinNames(names)} — answer in chat or let the AI decide.` : null;
}

/** The filmmaker describes a look themselves: a confirmed fact, even if they once removed the same text. */
export function addVisualLook(context: StoryContext, entity: VisualEntity, value: string): StoryContext {
  const text = value.trim().slice(0, MAX_FACT_VALUE);
  if (!text) return context;
  const key = visualFactKey(entity);
  const { removed: previous, ...rest } = context;
  const removed = (previous ?? []).filter((item) => !(item.key === key && sameFactValue(item.value, text)));
  const base: StoryContext = removed.length > 0 ? { ...rest, removed } : rest;
  const fact: ContextFact = {
    category: VISUAL_CATEGORY[entity.kind],
    label: visualLabel(entity),
    value: text,
    source: "user",
    approved: true,
  };
  return { ...base, ...mergeFacts(base, [fact]) };
}

export function lookExportStatus(row: LookRow): string {
  if (row.status === "confirmed") return "from you";
  if (row.status === "ai") return "AI suggestion — needs approval";
  if (row.status === "skipped") return row.fact ? "skipped, AI suggestion — needs approval" : "skipped — the AI will choose a look";
  return "not described";
}

export function lookExportItems(context: StoryContext | undefined): { lead: string; text: string }[] {
  if (!context) return [];
  return lookRows(context).map((row) => {
    const status = lookExportStatus(row);
    return {
      lead: `${row.entity.name.trim()} (${LOOK_KIND_LABELS[row.entity.kind]})`,
      text: row.fact ? `${row.fact.value} (${status})` : `${status.charAt(0).toUpperCase()}${status.slice(1)}`,
    };
  });
}

/** The labels `toCollected` gives look facts, so an export can list each look once. */
export function lookCollectedLabels(context: StoryContext | undefined): Set<string> {
  if (!context) return new Set();
  return new Set(
    lookRows(context).flatMap((row) => (row.fact ? [`${categoryOf(row.fact.category).label}: ${row.fact.label}`] : [])),
  );
}
