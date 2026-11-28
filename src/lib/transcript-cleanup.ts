import type { TranscribeHint } from "./transcription";

type Tokens = { seps: string[]; words: string[] };

type HintName = { name: string; key: string; words: number; limit: number; start: string };

const WORD = /([\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*)/u;
const FILLER = /^(?:um+|uh+m*|erm?|hm+|mm+)$/i;
const PAUSE_AFTER = /^[ \t]*(?:,|…|\.{3}|[–—]|-(?=\s))/;
const SENTENCE_END_BEFORE = /(?:[.!?…]["”'’)\]]*\s+|\n\s*)["“'‘(]*$/;
const TEXT_START = /^\s*["“'‘(]*$/;
const CLOSES = /^[\n.,!?;:…)\]}”’]/;
const OPENS = /(?:^|\s)["']$|[([{“‘]$/;
const POSSESSIVE = /['’]s$/i;
export const MIN_NAME_LETTERS = 4;

const ENGLISH = new Set(
  "the and of to with that this then they she you it his her their from into but what when where which who would should could have has are for at by just my our your not or if up out about after before there were".split(
    " ",
  ),
);

const OTHER_LANGUAGE = new Set(
  "der die das und ist nicht ich sie ein eine mit auf den dem zu het een niet ik je van dat de que não uma com para os el la los las y por del se le les et est une du il di che non gli un una nous vous".split(
    " ",
  ),
);

const KEEP_DOUBLED = new Set(
  "that had is do very really so no yes bye night far more too many much ha ho la oh ah hey go now there well wait come knock chop again one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred".split(
    " ",
  ),
);

const COMMON_WORDS = new Set(
  [
    "the then there these those they this that them their what when where while which who why how here now next later after before maybe also just even still only every each some many most more much both once soon again finally suddenly meanwhile",
    "inside outside behind above below under over across along around through into onto from with without okay yes yeah well like look see wait stop come make take give keep find hold move turn walk open close",
    "cut fade pan tilt zoom track dolly crane shot scene beat insert push pull wide slow fast back front left right camera music sound light dark night day morning evening dusk dawn rain storm title",
    "will may mark rise rose grace hope joy faith sky summer winter autumn spring art bill pat ray frank rich sunny june april august march monday tuesday wednesday thursday friday saturday sunday",
  ]
    .join(" ")
    .split(" "),
);

function tokenize(text: string): Tokens {
  const seps: string[] = [];
  const words: string[] = [];
  text.split(WORD).forEach((part, index) => {
    (index % 2 ? words : seps).push(part);
  });
  return { seps, words };
}

function join({ seps, words }: Tokens): string {
  return seps.map((sep, index) => sep + (words[index] ?? "")).join("");
}

function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function looksEnglish(words: readonly string[]): boolean {
  let english = 0;
  let other = 0;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (ENGLISH.has(lower)) english += 1;
    else if (OTHER_LANGUAGE.has(lower)) other += 1;
  }
  if (english || other) return english > other;
  return words.every((word) => /^[\p{Script=Latin}\p{M}\p{N}'’-]+$/u.test(word));
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function isFiller(word: string, previous: string | undefined): boolean {
  if (!FILLER.test(word)) return false;
  if (word.length > 1 && word === word.toUpperCase()) return false;
  return !(/^mm+$/i.test(word) && previous !== undefined && /\d$/.test(previous));
}

function mergeAround(before: string, after: string, sentenceStart: boolean, atStart: boolean, atEnd: boolean): string {
  let right = after.replace(PAUSE_AFTER, "");
  if (sentenceStart) right = right.replace(/^[ \t]*[.!?]+/, "");
  const rightCore = right.replace(/^[ \t]+/, "");
  let left = before.replace(/[ \t]+$/, "");
  const spaced = left.length < before.length || rightCore.length < right.length;
  if (/^[.!?;:…]/.test(rightCore) || (atEnd && !rightCore)) left = left.replace(/,$/, "");
  const glue =
    spaced &&
    !(atStart && !left) &&
    !(atEnd && !rightCore) &&
    !left.endsWith("\n") &&
    !CLOSES.test(rightCore) &&
    !OPENS.test(left);
  return left + (glue ? " " : "") + rightCore;
}

function dropFillers(tokens: Tokens): void {
  const { seps, words } = tokens;
  let index = 0;
  while (index < words.length) {
    if (!isFiller(words[index], words[index - 1])) {
      index += 1;
      continue;
    }
    const sentenceStart = index === 0 ? TEXT_START.test(seps[0]) : SENTENCE_END_BEFORE.test(seps[index]);
    const merged = mergeAround(seps[index], seps[index + 1], sentenceStart, index === 0, index === words.length - 1);
    seps.splice(index, 2, merged);
    words.splice(index, 1);
    if (sentenceStart && index < words.length) words[index] = capitalise(words[index]);
  }
}

function collapseRepeats(tokens: Tokens): void {
  const { seps, words } = tokens;
  let index = 0;
  while (index + 1 < words.length) {
    const second = words[index + 1];
    const repeated =
      /^[ \t]+$/.test(seps[index + 1]) &&
      second === words[index].toLowerCase() &&
      /^\p{L}/u.test(second) &&
      !KEEP_DOUBLED.has(second);
    if (repeated) {
      words.splice(index + 1, 1);
      seps.splice(index + 1, 1);
    } else {
      index += 1;
    }
  }
}

function soundStart(key: string): string {
  if (key.startsWith("ph")) return "f";
  if (/^c[aoulr]/.test(key)) return "k";
  return key.charAt(0);
}

function hintNames(hint: Pick<TranscribeHint, "names">): HintName[] {
  return hint.names.flatMap((name) => {
    const key = normalise(name);
    const words = name.trim().split(/\s+/).length;
    if (words > 2 || key.length < MIN_NAME_LETTERS) return [];
    return [{ name, key, words, limit: key.length <= 5 ? 1 : 2, start: soundStart(key) }];
  });
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function closestName(key: string, words: number, names: readonly HintName[]): HintName | null {
  let best: HintName | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;
  const start = soundStart(key);
  for (const name of names) {
    if (name.words !== words || name.start !== start || key === `${name.key}s`) continue;
    const distance = editDistance(key, name.key, name.limit);
    if (distance > name.limit) continue;
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && name.key !== best?.key) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function isNameLike(word: string): boolean {
  return (
    /^\p{Lu}[\p{L}\p{M}'’-]*$/u.test(word) &&
    /\p{Ll}/u.test(word.slice(1)) &&
    !COMMON_WORDS.has(normalise(word.replace(POSSESSIVE, "")))
  );
}

function fixNames(tokens: Tokens, names: readonly HintName[]): void {
  const { seps, words } = tokens;
  for (let index = 0; index < words.length; index += 1) {
    for (const size of [2, 1]) {
      const span = words.slice(index, index + size);
      if (span.length < size || !span.every(isNameLike)) continue;
      if (size === 2 && !/^[ \t]+$/.test(seps[index + 1])) continue;
      const last = span[size - 1];
      const suffix = POSSESSIVE.exec(last)?.[0] ?? "";
      span[size - 1] = last.slice(0, last.length - suffix.length);
      const match = closestName(normalise(span.join(" ")), size, names);
      if (!match) continue;
      words.splice(index, size, match.name + suffix);
      seps.splice(index + 1, size - 1);
      break;
    }
  }
}

// English-only: in other languages "um", "er" or a doubled word can be real words.
export function cleanTranscript(text: string, hint: Pick<TranscribeHint, "names">): string {
  const tokens = tokenize(text);
  if (!tokens.words.length || !looksEnglish(tokens.words)) return text.trim();
  dropFillers(tokens);
  collapseRepeats(tokens);
  fixNames(tokens, hintNames(hint));
  return join(tokens).trim();
}
