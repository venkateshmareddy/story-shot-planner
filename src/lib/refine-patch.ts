import { MAX_RENAMES, type RefinePatch, type Rename, type ShotPlan } from "./story-planning";

type Scene = ShotPlan["scenes"][number];

export function isUsableScene(scene: Scene): boolean {
  return (
    scene.shots.length > 0 &&
    scene.shots.every(({ seconds }) => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)
  );
}

function changedText(value: string | null, current: string): string {
  return value?.trim() ? value : current;
}

/**
 * Applies a refine patch to the plan it was made for. Every scene edit refers to the ORIGINAL scene indices.
 * null when the patch can't be applied safely: an index out of range, two replace/remove edits for one scene,
 * a missing scene on replace/insert, a new scene without shots or with a non-positive duration, or no scenes left.
 * Only scenes the patch writes are checked, so a scene the filmmaker emptied by hand doesn't block other edits.
 * Pure and immutable: the result is a fresh copy.
 */
export function applyRefinePatch(plan: ShotPlan, patch: RefinePatch): ShotPlan | null {
  const count = plan.scenes.length;
  const replaced = new Map<number, Scene | null>();
  const inserted = new Map<number, Scene[]>();
  for (const { action, index, scene } of patch.sceneEdits) {
    if (!Number.isInteger(index)) return null;
    if (action === "insert_after") {
      if (index < -1 || index >= count || !scene || !isUsableScene(scene)) return null;
      inserted.set(index, [...(inserted.get(index) ?? []), scene]);
      continue;
    }
    if (index < 0 || index >= count || replaced.has(index)) return null;
    if (action === "replace" && (!scene || !isUsableScene(scene))) return null;
    replaced.set(index, action === "replace" ? scene : null);
  }

  const scenes: Scene[] = [...(inserted.get(-1) ?? [])];
  plan.scenes.forEach((original, index) => {
    const next = replaced.has(index) ? replaced.get(index) : original;
    if (next) scenes.push(next);
    scenes.push(...(inserted.get(index) ?? []));
  });
  if (!scenes.length) return null;

  return structuredClone({
    title: changedText(patch.title, plan.title),
    logline: changedText(patch.logline, plan.logline),
    intent: changedText(patch.intent, plan.intent),
    characters: patch.characters ?? plan.characters,
    locations: patch.locations ?? plan.locations,
    scenes,
    reviewNotes: patch.reviewNotes ?? plan.reviewNotes,
  });
}

export const MAX_RENAME_CHARACTERS = 80;

type NameKind = "character" | "location";
type ValidRename = Rename & { kind: NameKind };

const LEADING_ARTICLE = /^the\s+/i;
const NOT_WORD = String.raw`(?<![\p{L}\p{N}_])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Every name shown on the board, in its first spelling: tables first, then who/where columns and speakers. */
function boardNames(plan: ShotPlan): Map<string, { name: string; kind: NameKind }> {
  const names = new Map<string, { name: string; kind: NameKind }>();
  const add = (name: string, kind: NameKind) => {
    const key = nameKey(name);
    if (key && !names.has(key)) names.set(key, { name: name.trim(), kind });
  };
  for (const { name } of plan.characters) add(name, "character");
  for (const { name } of plan.locations) add(name, "location");
  for (const { shots } of plan.scenes) {
    for (const shot of shots) {
      for (const name of shot.characters) add(name, "character");
      for (const { speaker } of shot.dialogue) add(speaker, "character");
      add(shot.location, "location");
    }
  }
  return names;
}

/**
 * The renames that can be applied safely, in order, at most MAX_RENAMES: `from` must be a name on the board (it is
 * replaced by the board's own spelling), `to` must be new, both non-empty and at most MAX_RENAME_CHARACTERS long.
 * A `to` that is already another name would merge two people or places, so it is dropped.
 */
export function validRenames(plan: ShotPlan, renames: readonly Rename[]): ValidRename[] {
  const names = boardNames(plan);
  const fromKeys = new Set<string>();
  const toKeys = new Set<string>();
  const valid: ValidRename[] = [];
  for (const rename of renames) {
    if (valid.length >= MAX_RENAMES) break;
    const to = rename.to.trim().replace(/\s+/g, " ");
    const known = names.get(nameKey(rename.from));
    if (!known || !to || rename.from.trim().length > MAX_RENAME_CHARACTERS || to.length > MAX_RENAME_CHARACTERS) continue;
    const fromKey = nameKey(known.name);
    const toKey = nameKey(to);
    if (to === known.name || fromKeys.has(fromKey) || toKeys.has(toKey)) continue;
    if (toKey !== fromKey && names.has(toKey)) continue;
    fromKeys.add(fromKey);
    toKeys.add(toKey);
    valid.push({ from: known.name, to, kind: known.kind });
  }
  return valid;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phrasePattern(phrase: string): string {
  return phrase.trim().split(/\s+/).map(escapeRegExp).join(String.raw`\s+`);
}

type Renamer = { value: (text: string) => string; text: (text: string) => string };

/**
 * Text matches are case-sensitive (a proper-name use), so "the lonely lighthouse keeper" survives renaming the
 * character "Keeper". A character name also takes a directly preceding "the" with it ("the Keeper's chair" ->
 * "Aswin's chair"); a place keeps its "the" ("in the Kitchen" -> "in the Bakery").
 */
function renamer(renames: readonly ValidRename[]): Renamer {
  const byValue = new Map(renames.map(({ from, to }) => [nameKey(from), to]));
  const entries = [...renames].sort((a, b) => b.from.length - a.from.length);
  const pattern = entries
    .map(({ from }, index) => {
      const body = LEADING_ARTICLE.test(from)
        ? String.raw`[Tt]he\s+${phrasePattern(from.replace(LEADING_ARTICLE, ""))}`
        : String.raw`(?:[Tt]he\s+)?${phrasePattern(from)}`;
      return `${NOT_WORD}(?<r${index}>${body})${NOT_WORD_AFTER}`;
    })
    .join("|");
  const matcher = entries.length ? new RegExp(pattern, "gu") : null;

  const replace = (match: string, groups: Record<string, string | undefined>) => {
    const entry = entries.find((_, index) => groups[`r${index}`] !== undefined);
    if (!entry) return match;
    const article = /^([Tt]he)\s+/.exec(match)?.[1];
    const toRest = entry.to.replace(LEADING_ARTICLE, "");
    const keepArticle =
      article && (LEADING_ARTICLE.test(entry.to) || (entry.kind === "location" && !LEADING_ARTICLE.test(entry.from)));
    return keepArticle ? `${article} ${toRest}` : entry.to;
  };
  const text = (value: string) =>
    matcher
      ? value.replace(matcher, (match: string, ...rest: unknown[]) =>
          replace(match, rest.at(-1) as Record<string, string | undefined>),
        )
      : value;
  return { text, value: (value: string) => byValue.get(nameKey(value)) ?? text(value) };
}

/**
 * Applies name changes everywhere a name appears. A name column (character and place tables, who/where, speaker)
 * whose whole value is the old name (any case) gets the new name; every other mention is matched in text.
 * The film title is left alone. Invalid renames are ignored (see validRenames). Pure: the result is a fresh copy.
 */
export function applyRenames(plan: ShotPlan, renames: readonly Rename[]): ShotPlan {
  const valid = validRenames(plan, renames);
  if (!valid.length) return structuredClone(plan);
  const { text, value } = renamer(valid);
  return {
    title: plan.title,
    logline: text(plan.logline),
    intent: text(plan.intent),
    characters: plan.characters.map(({ name, role, look, personality, voice }) => ({
      name: value(name),
      role: text(role),
      look: text(look),
      personality: text(personality),
      voice: text(voice),
    })),
    locations: plan.locations.map(({ name, description }) => ({ name: value(name), description: text(description) })),
    scenes: plan.scenes.map(({ title, shots }) => ({
      title: text(title),
      shots: shots.map((shot) => ({
        seconds: shot.seconds,
        framing: text(shot.framing),
        camera: text(shot.camera),
        characters: shot.characters.map(value),
        location: value(shot.location),
        action: text(shot.action),
        dialogue: shot.dialogue.map(({ speaker, line, delivery }) => ({
          speaker: value(speaker),
          line: text(line),
          delivery: text(delivery),
        })),
        emotion: text(shot.emotion),
        sound: text(shot.sound),
      })),
    })),
    reviewNotes: plan.reviewNotes.map(text),
  };
}

/**
 * Whole-value renames of the name columns only, for content the model wrote after the rename. `renames` must come from
 * validRenames on the plan before the edit; no new name is an old one, so applying this twice changes nothing.
 */
export function renameNameColumns(plan: ShotPlan, renames: readonly Rename[]): ShotPlan {
  const byValue = new Map(renames.map(({ from, to }) => [nameKey(from), to]));
  const value = (name: string) => byValue.get(nameKey(name)) ?? name;
  const copy = structuredClone(plan);
  if (!byValue.size) return copy;
  for (const character of copy.characters) character.name = value(character.name);
  for (const location of copy.locations) location.name = value(location.name);
  for (const { shots } of copy.scenes) {
    for (const shot of shots) {
      shot.characters = shot.characters.map(value);
      shot.location = value(shot.location);
      for (const line of shot.dialogue) line.speaker = value(line.speaker);
    }
  }
  return copy;
}
