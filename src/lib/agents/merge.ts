import type { ShotPlan } from "@/lib/story-planning";
import { type EditField, PLAN_LEVEL_FIELDS, SCENE_LEVEL_FIELDS, type SpecialistEdit } from "./schemas";
import { clip, MAX_SPECIALIST_EDITS, shotId } from "./shared";
import { SPECIALIST_LABELS, type SpecialistId } from "./types";

/** Fixed tie-break when two specialists propose the same scene/shot/field: story intent first, then factual continuity, then craft. */
export const MERGE_PRIORITY: readonly SpecialistId[] = [
  "story-analyst",
  "continuity-reviewer",
  "cinematography-director",
  "editing-director",
  "sound-director",
];

const FIELD_LABELS: Record<EditField, string> = {
  logline: "logline",
  intent: "intent",
  sceneTitle: "scene title",
  action: "action",
  framing: "framing",
  camera: "camera",
  sound: "sound",
  seconds: "duration",
  location: "location",
  characters: "characters",
};

const FIELD_ORDER = Object.keys(FIELD_LABELS) as EditField[];
const MAX_VALUE_CHARACTERS = 2_000;
const MAX_SHOT_SECONDS = 600;

type EditValue = string | number | string[];

export type ValidEdit = {
  specialist: SpecialistId;
  field: EditField;
  /** 1-based; 0 for plan-level fields. */
  scene: number;
  /** 1-based; null for plan- and scene-level fields. */
  shot: number | null;
  value: EditValue;
  previous: EditValue;
  target: string;
  key: string;
};

const isEditField = (field: string, allowed: readonly EditField[]): field is EditField =>
  (allowed as readonly string[]).includes(field);

const sameValue = (a: EditValue, b: EditValue) => JSON.stringify(a) === JSON.stringify(b);

function display(value: EditValue, max = 140) {
  if (typeof value === "number") return `${value}s`;
  return `“${clip(Array.isArray(value) ? value.join(", ") : value, max)}”`;
}

function normalizeValue(field: EditField, raw: string, plan: ShotPlan): EditValue | null {
  if (field === "seconds") {
    const seconds = Math.round(Number(raw) * 10) / 10;
    return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SHOT_SECONDS ? seconds : null;
  }
  if (field === "characters") {
    const known = new Map(plan.characters.map(({ name }) => [name.trim().toLowerCase(), name]));
    const names = raw
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => (known.size ? known.get(name.toLowerCase()) : name))
      .filter((name): name is string => Boolean(name));
    const unique = [...new Set(names)];
    return unique.length ? unique : null;
  }
  return raw;
}

/** Keeps only edits this specialist owns, that point at an existing scene/shot and change a valid value; the first MAX_SPECIALIST_EDITS distinct ones. */
export function sanitizeEdits(
  plan: ShotPlan,
  specialist: SpecialistId,
  allowed: readonly EditField[],
  edits: readonly SpecialistEdit[],
): ValidEdit[] {
  const valid: ValidEdit[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (valid.length >= MAX_SPECIALIST_EDITS) break;
    if (!isEditField(edit.field, allowed)) continue;
    const field = edit.field;
    const raw = typeof edit.value === "string" ? edit.value.trim() : "";
    if (!raw || raw.length > MAX_VALUE_CHARACTERS) continue;

    let scene = 0;
    let shot: number | null = null;
    let previous: EditValue;
    let target = "Plan";
    if (field === "logline" || field === "intent") {
      previous = plan[field];
    } else {
      if (!Number.isInteger(edit.scene) || edit.scene < 1 || edit.scene > plan.scenes.length) continue;
      scene = edit.scene;
      const sceneData = plan.scenes[scene - 1];
      if (field === "sceneTitle") {
        previous = sceneData.title;
        target = `Scene ${scene}`;
      } else {
        if (edit.shot === null || !Number.isInteger(edit.shot) || edit.shot < 1 || edit.shot > sceneData.shots.length) {
          continue;
        }
        shot = edit.shot;
        previous = sceneData.shots[shot - 1][field];
        target = shotId(scene - 1, shot - 1);
      }
    }

    const value = normalizeValue(field, raw, plan);
    const key = `${field}:${scene}:${shot ?? "-"}`;
    if (value === null || sameValue(value, previous) || seen.has(key)) continue;
    seen.add(key);
    valid.push({ specialist, field, scene, shot, value, previous, target, key });
  }
  return valid;
}

function applyEdit(plan: ShotPlan, edit: ValidEdit) {
  const { field, value } = edit;
  if (field === "logline" || field === "intent") {
    plan[field] = String(value);
    return;
  }
  const scene = plan.scenes[edit.scene - 1];
  if (field === "sceneTitle") {
    scene.title = String(value);
    return;
  }
  if (edit.shot === null) return;
  const shot = scene.shots[edit.shot - 1];
  if (field === "seconds") shot.seconds = Number(value);
  else if (field === "characters") shot.characters = Array.isArray(value) ? value : [String(value)];
  else shot[field] = String(value);
}

const position = (edit: ValidEdit) => [
  PLAN_LEVEL_FIELDS.includes(edit.field) ? -1 : edit.scene,
  SCENE_LEVEL_FIELDS.includes(edit.field) ? -1 : (edit.shot ?? -1),
  FIELD_ORDER.indexOf(edit.field),
];

/** Applies sanitised edits to a deep copy. The input plan is never mutated. */
export function mergeEdits(plan: ShotPlan, edits: readonly ValidEdit[]) {
  const ordered = [...edits].sort(
    (a, b) => MERGE_PRIORITY.indexOf(a.specialist) - MERGE_PRIORITY.indexOf(b.specialist),
  );
  const winners = new Map<string, ValidEdit>();
  const conflicts: string[] = [];
  for (const edit of ordered) {
    const kept = winners.get(edit.key);
    if (!kept) {
      winners.set(edit.key, edit);
    } else if (kept.specialist !== edit.specialist && !sameValue(kept.value, edit.value)) {
      conflicts.push(
        `${edit.target} ${FIELD_LABELS[edit.field]}: kept ${SPECIALIST_LABELS[kept.specialist]}'s proposal ${display(kept.value, 80)}; ${SPECIALIST_LABELS[edit.specialist]} suggested ${display(edit.value, 80)} as an alternative.`,
      );
    }
  }

  const applied = [...winners.values()].sort((a, b) => {
    const [pa, pb] = [position(a), position(b)];
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
  if (!applied.length) return { plan: null, applied, conflicts, changeSummary: [] as string[] };

  const next = structuredClone(plan);
  for (const edit of applied) applyEdit(next, edit);
  const changeSummary = applied.map((edit) => {
    const change =
      typeof edit.value === "number" || edit.field === "characters" || edit.field === "location"
        ? `${display(edit.previous, 60)} → ${display(edit.value)}`
        : `→ ${display(edit.value)}`;
    return `${edit.target} ${FIELD_LABELS[edit.field]} ${change} (${SPECIALIST_LABELS[edit.specialist]})`;
  });
  return { plan: next, applied, conflicts, changeSummary };
}
