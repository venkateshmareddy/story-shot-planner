const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const WORD_ORDINALS: Readonly<Record<string, number>> = {
  first: 1, opening: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

const NUM = `(?:\\d{1,3}|${Object.keys(WORD_NUMBERS).join("|")})`;
const ORD = `(?:second[- ]to[- ]last|penultimate|last|final|closing|\\d{1,3}(?:st|nd|rd|th)|${Object.keys(WORD_ORDINALS).join("|")})`;
const SEPARATOR = String.raw`\s*(?:,\s*(?:and\s+|or\s+)?|&|and|or|-|–|to|through|thru)\s*`;
// "scene 2 to 10 seconds" is a duration, not a range of scenes.
const NOT_A_UNIT = String.raw`(?!\s*(?:s|secs?|seconds?|mins?|minutes?|%)\b)`;

const SCENE_NUMBERS = new RegExp(String.raw`\bscenes?\s+(?:#|no\.?\s*|number\s+)?(${NUM}(?:${SEPARATOR}#?${NUM}${NOT_A_UNIT})*)\b`, "g");
const SCENE_ORDINALS = new RegExp(String.raw`\b(${ORD}(?:\s*(?:,|&|and|or)\s*(?:the\s+)?${ORD})*)\s+scenes?\b`, "g");
// S02 or S02_SH03 (a shot id names its scene). `_` is a word character, so \b keeps "S02_SH03" whole.
const SCENE_CODES = /\bs(\d{1,3})(?:_?sh\d{1,3})?\b/g;
const WHOLE_FILM =
  /\b(?:(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?scenes?|(?:whole|entire|full)\s+(?:film|movie|plan|story|script|short)|throughout\s+(?:the\s+)?(?:film|movie|plan|story)|across\s+(?:all\s+)?(?:the\s+)?(?:film|movie|plan|scenes))\b/;
const SCENE_STRUCTURE_EDIT = new RegExp(
  String.raw`\b(?:add|insert|delete|remove|drop|cut|split|merge|combine|join|duplicate|reorder|swap|move)\s+(?:(?:a|an|the|new|another|extra|this|that|these|those|both|${ORD}|${NUM})\s+)*(?:scenes?\b|s\d{1,3}\b)`,
);

function normalize(message: string) {
  return message.toLowerCase().replace(/[’‘]/g, "'");
}

function toNumber(token: string): number {
  return WORD_NUMBERS[token] ?? Number.parseInt(token, 10);
}

/** 1-based scene number for an ordinal word, relative to the plan's length. */
function ordinalNumber(token: string, sceneCount: number): number {
  const word = token.replace(/[- ]/g, " ");
  if (word === "last" || word === "final" || word === "closing") return sceneCount;
  if (word === "penultimate" || word === "second to last") return sceneCount - 1;
  return WORD_ORDINALS[word] ?? Number.parseInt(word, 10);
}

function numberedScenes(list: string, sceneCount: number): number[] {
  const tokens = list.match(new RegExp(`${NUM}|-|–|\\bto\\b|\\bthrough\\b|\\bthru\\b`, "g")) ?? [];
  const numbers: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^\d|^[a-z]+$/.test(token) && !/^(?:to|through|thru)$/.test(token)) {
      numbers.push(toNumber(token));
      continue;
    }
    const from = numbers.at(-1);
    const next = tokens[index + 1];
    if (from === undefined || next === undefined) continue;
    const to = toNumber(next);
    const [low, high] = from <= to ? [from, to] : [to, from];
    for (let scene = Math.max(low, 1); scene <= Math.min(high, sceneCount); scene += 1) numbers.push(scene);
    index += 1;
  }
  return numbers;
}

/**
 * 0-based indices of the scenes a revision request targets, ascending and deduped.
 * [] when no specific scene is named or the whole film is meant.
 */
export function findTargetScenes(message: string, sceneCount: number): number[] {
  const text = normalize(message);
  if (sceneCount < 1 || WHOLE_FILM.test(text)) return [];
  const numbers: number[] = [];
  for (const [, list] of text.matchAll(SCENE_NUMBERS)) numbers.push(...numberedScenes(list, sceneCount));
  for (const [, list] of text.matchAll(SCENE_ORDINALS)) {
    for (const [token] of list.matchAll(new RegExp(ORD, "g"))) numbers.push(ordinalNumber(token, sceneCount));
  }
  for (const [, digits] of text.matchAll(SCENE_CODES)) numbers.push(Number.parseInt(digits, 10));
  return [...new Set(numbers)]
    .filter((scene) => Number.isInteger(scene) && scene >= 1 && scene <= sceneCount)
    .sort((a, b) => a - b)
    .map((scene) => scene - 1);
}

/** Adds, removes, splits, merges or reorders whole scenes: the scene count or order changes, so only a full refine fits. */
export function isSceneStructureEdit(message: string): boolean {
  return SCENE_STRUCTURE_EDIT.test(normalize(message));
}
