import type { ShotPlan } from "@/lib/story-planning";

type Scene = ShotPlan["scenes"][number];
type Shot = Scene["shots"][number];
type Character = ShotPlan["characters"][number];
type Location = ShotPlan["locations"][number];

export type PlanChangeKind = "changed" | "added" | "removed";

export type PlanChange = {
  kind: PlanChangeKind;
  /** Where on the board: "Overview", "Character: Mara", "Place: Pier", "S03", "S03_SH02". */
  where: string;
  /** The field in plain words, or "Scene"/"Shot"/"Character"/"Place" for an addition or removal. */
  what: string;
  before: string;
  after: string;
};

export type PlanDiff = { changes: PlanChange[]; hidden: number };

export const MAX_PLAN_DIFF_CHANGES = 40;
export const MAX_PLAN_DIFF_TEXT = 220;

const OVERVIEW_FIELDS = [
  ["title", "Title"],
  ["logline", "One-line summary"],
  ["intent", "What the film is about"],
] as const satisfies readonly (readonly [keyof ShotPlan, string])[];

const CHARACTER_FIELDS = [
  ["role", "Role"],
  ["look", "Look"],
  ["personality", "Personality"],
  ["voice", "How they speak"],
] as const satisfies readonly (readonly [keyof Character, string])[];

const SHOT_FIELDS: readonly (readonly [string, (shot: Shot) => string])[] = [
  ["What happens", (shot) => shot.action],
  ["Length (seconds)", (shot) => String(shot.seconds)],
  ["Shot size", (shot) => shot.framing],
  ["Camera movement", (shot) => shot.camera],
  ["Who’s in it", (shot) => shot.characters.join(", ")],
  ["Place", (shot) => shot.location],
  ["Dialogue", (shot) => shot.dialogue.map(dialogueLine).join(" / ")],
  ["Feeling", (shot) => shot.emotion],
  ["Sound", (shot) => shot.sound],
];

function dialogueLine(line: Shot["dialogue"][number]): string {
  const delivery = line.delivery.trim() ? ` (${line.delivery.trim()})` : "";
  return `${line.speaker.trim()}${delivery}: ${line.line.trim()}`;
}

function clip(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > MAX_PLAN_DIFF_TEXT ? `${clean.slice(0, MAX_PLAN_DIFF_TEXT - 1).trimEnd()}…` : clean;
}

function sameText(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
}

function normalName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function sceneCode(index: number): string {
  return `S${String(index + 1).padStart(2, "0")}`;
}

export function shotCode(scene: number, shot: number): string {
  return `${sceneCode(scene)}_SH${String(shot + 1).padStart(2, "0")}`;
}

function changed(where: string, what: string, before: string, after: string): PlanChange | null {
  return sameText(before, after) ? null : { kind: "changed", where, what, before: clip(before), after: clip(after) };
}

function namedListChanges<T extends { name: string }>(
  before: readonly T[],
  after: readonly T[],
  noun: string,
  summary: (item: T) => string,
  fields: readonly (readonly [keyof T, string])[],
): PlanChange[] {
  const changes: PlanChange[] = [];
  const afterByName = new Map(after.map((item) => [normalName(item.name), item]));
  const beforeNames = new Set(before.map((item) => normalName(item.name)));
  for (const item of before) {
    const match = afterByName.get(normalName(item.name));
    const where = `${noun}: ${item.name.trim() || "(no name)"}`;
    if (!match) {
      changes.push({ kind: "removed", where, what: noun, before: clip(summary(item)), after: "" });
      continue;
    }
    for (const [field, label] of fields) {
      const change = changed(where, label, String(item[field]), String(match[field]));
      if (change) changes.push(change);
    }
  }
  for (const item of after) {
    if (beforeNames.has(normalName(item.name))) continue;
    changes.push({
      kind: "added",
      where: `${noun}: ${item.name.trim() || "(no name)"}`,
      what: noun,
      before: "",
      after: clip(summary(item)),
    });
  }
  return changes;
}

/** Index pairs of the longest common run of scene titles, in order. */
function titleAnchors(before: readonly Scene[], after: readonly Scene[]): [number, number][] {
  const a = before.map((scene) => normalName(scene.title));
  const b = after.map((scene) => normalName(scene.title));
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

type SceneStep = { kind: "match"; before: number; after: number } | { kind: "removed"; before: number } | { kind: "added"; after: number };

/** Scenes matched by title; unmatched scenes between the same anchors pair up by position, the rest are added or removed. */
function alignScenes(before: readonly Scene[], after: readonly Scene[]): SceneStep[] {
  const steps: SceneStep[] = [];
  const anchors = [...titleAnchors(before, after), [before.length, after.length] as [number, number]];
  let i = 0;
  let j = 0;
  for (const [anchorBefore, anchorAfter] of anchors) {
    while (i < anchorBefore && j < anchorAfter) steps.push({ kind: "match", before: i++, after: j++ });
    while (i < anchorBefore) steps.push({ kind: "removed", before: i++ });
    while (j < anchorAfter) steps.push({ kind: "added", after: j++ });
    if (anchorBefore < before.length) steps.push({ kind: "match", before: i++, after: j++ });
  }
  return steps;
}

function sceneChanges(index: number, before: Scene, after: Scene): PlanChange[] {
  const changes: PlanChange[] = [];
  const title = changed(sceneCode(index), "Scene title", before.title, after.title);
  if (title) changes.push(title);
  const count = Math.max(before.shots.length, after.shots.length);
  for (let shot = 0; shot < count; shot += 1) {
    const where = shotCode(index, shot);
    const old = before.shots[shot];
    const next = after.shots[shot];
    if (!old && next) {
      changes.push({ kind: "added", where, what: "Shot", before: "", after: clip(next.action) });
    } else if (old && !next) {
      changes.push({ kind: "removed", where, what: "Shot", before: clip(old.action), after: "" });
    } else if (old && next) {
      for (const [label, read] of SHOT_FIELDS) {
        const change = changed(where, label, read(old), read(next));
        if (change) changes.push(change);
      }
    }
  }
  return changes;
}

/**
 * What a proposal changes on the board, in board order. Changed and removed items use the current board's
 * scene and shot numbers; added scenes use their new number.
 */
export function planDiff(before: ShotPlan, after: ShotPlan, limit = MAX_PLAN_DIFF_CHANGES): PlanDiff {
  const changes: PlanChange[] = [];
  for (const [field, label] of OVERVIEW_FIELDS) {
    const change = changed("Overview", label, before[field], after[field]);
    if (change) changes.push(change);
  }
  const notes = changed("Overview", "Review notes", before.reviewNotes.join(" / "), after.reviewNotes.join(" / "));
  if (notes) changes.push(notes);
  changes.push(
    ...namedListChanges(before.characters, after.characters, "Character", (item) => item.role, CHARACTER_FIELDS),
    ...namedListChanges<Location>(
      before.locations,
      after.locations,
      "Place",
      (item) => item.description,
      [["description", "Description"]],
    ),
  );
  for (const step of alignScenes(before.scenes, after.scenes)) {
    if (step.kind === "match") {
      changes.push(...sceneChanges(step.before, before.scenes[step.before], after.scenes[step.after]));
    } else if (step.kind === "removed") {
      const scene = before.scenes[step.before];
      changes.push({ kind: "removed", where: sceneCode(step.before), what: "Scene", before: clip(scene.title), after: "" });
    } else {
      const scene = after.scenes[step.after];
      changes.push({ kind: "added", where: `New ${sceneCode(step.after)}`, what: "Scene", before: "", after: clip(scene.title) });
    }
  }
  const cap = Math.max(0, Math.floor(limit));
  return { changes: changes.slice(0, cap), hidden: Math.max(0, changes.length - cap) };
}
