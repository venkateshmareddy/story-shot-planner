import {
  type ContextFact,
  type FactSource,
  factKey,
  MAX_FACT_VALUE,
  MAX_VISUAL_ENTITIES,
  MAX_VISUAL_NAME,
  type StoryCategoryId,
  type StoryContext,
  VISUAL_CATEGORY,
  type VisualEntity,
  type VisualKind,
  visualFactKey,
  visualLabel,
  visualStatus,
} from "./story-context";

export const MAX_VISUAL_MENTIONS = 6;
export const CONDITIONS_NAME = "Time of day and weather";

export type VisualMention = {
  name: string;
  kind: VisualKind;
  key: boolean;
  central: boolean;
  look: string;
  source: FactSource;
};

export type LookFact = { category: StoryCategoryId; label: string; value: string; source: FactSource };

// Clipped on write: one invalid name would make the saved session fail storyContextSchema and be dropped.
export function cleanVisualName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_VISUAL_NAME).trim();
}

const ARTICLES = new Set(["the", "a", "an"]);

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word && !ARTICLES.has(word));
}

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((word, i) => word === b[i]);

function endsWith(long: readonly string[], short: readonly string[]): boolean {
  return short.length > 0 && short.length < long.length && sameWords(long.slice(long.length - short.length), short);
}

function startsWith(long: readonly string[], short: readonly string[]): boolean {
  return short.length > 0 && short.length < long.length && sameWords(long.slice(0, short.length), short);
}

// The head noun comes last ("house" = "Old house", but "Car" ≠ "Car keys"); people and conditions also go by a first part ("Mara" = "Mara Cole").
function partOf(a: readonly string[], b: readonly string[], kind: VisualKind): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return endsWith(long, short) || ((kind === "character" || kind === "conditions") && startsWith(long, short));
}

function matchIndex(visuals: readonly VisualEntity[], name: string, kind?: VisualKind): number {
  const words = nameWords(name);
  if (!words.length) return -1;
  const candidates = visuals
    .map((entity, index) => ({ entity, index, words: nameWords(entity.name) }))
    .filter(({ entity }) => kind === undefined || VISUAL_CATEGORY[entity.kind] === VISUAL_CATEGORY[kind]);
  const exact = candidates.find((candidate) => sameWords(candidate.words, words));
  if (exact) return exact.index;
  const partial = candidates.filter((candidate) => partOf(candidate.words, words, kind ?? candidate.entity.kind));
  return partial.length === 1 ? partial[0].index : -1;
}

const LOOK_CUE = /\b(look|looks|looking|like|appear|appears|appearance|wear|wears|wearing|dressed|colou?rs?|style|kind of|light|lighting|weather|time of day)\b/i;
const CONDITIONS_CUE = /\b(light|lighting|weather|time of day|dawn|dusk|sunrise|sunset|night|morning|afternoon|evening|season|rain|fog|mist|storm)/i;

function firstMention(question: string, words: readonly string[]): number {
  if (!words.length) return -1;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}(?:s|'s|’s)?(?![\\p{L}\\p{N}])`, "iu");
  return question.search(pattern);
}

/**
 * When the model leaves `asks` empty, the look question's subject is read from its text: a question with a look cue
 * ("look like", "wear", "light") about an open gap, taking the gap mentioned first. Story questions have no cue.
 */
export function inferAsks(question: string, gaps: readonly VisualEntity[]): VisualEntity | undefined {
  if (!LOOK_CUE.test(question)) return undefined;
  const positions = gaps
    .map((entity) => ({
      entity,
      at: entity.kind === "conditions" ? question.search(CONDITIONS_CUE) : firstMention(question, nameWords(entity.name)),
    }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at);
  return positions[0]?.entity;
}

export function findVisual(visuals: readonly VisualEntity[], name: string): VisualEntity | undefined {
  const index = matchIndex(visuals, name);
  return index === -1 ? undefined : visuals[index];
}

export const sameVisual = (a: VisualEntity, b: VisualEntity) => a.kind === b.kind && sameWords(nameWords(a.name), nameWords(b.name));

// Over the cap, minor things go first, then the newest key things; asked ones are kept so a repeat is still caught.
export function capVisuals(visuals: readonly VisualEntity[]): VisualEntity[] {
  const kept = [...visuals];
  const tiers = [
    (entity: VisualEntity) => !entity.key && entity.asked === undefined,
    (entity: VisualEntity) => entity.asked === undefined,
    () => true,
  ];
  for (const removable of tiers) {
    for (let index = kept.length - 1; index >= 0 && kept.length > MAX_VISUAL_ENTITIES; index -= 1) {
      if (removable(kept[index])) kept.splice(index, 1);
    }
  }
  return kept;
}

function relabelLook(facts: readonly ContextFact[], from: VisualEntity, to: VisualEntity): ContextFact[] {
  const oldKey = visualFactKey(from);
  const newKey = visualFactKey(to);
  if (oldKey === newKey || facts.some((fact) => factKey(fact) === newKey)) return [...facts];
  return facts.map((fact) => (factKey(fact) === oldKey ? { ...fact, label: visualLabel(to) } : fact));
}

const LOOK_FILLER = new Set(["it", "its", "it's", "that's", "is", "was", "looks", "look", "like", "very", "quite", "really", "kind", "of", "and"]);

/** A look that only repeats words of the thing's own name ("old" for "Old house") doesn't describe it yet. */
export function addsToName(look: string, name: string): boolean {
  const own = new Set(nameWords(name));
  return nameWords(look).some((word) => !own.has(word) && !LOOK_FILLER.has(word));
}

export function trackVisuals(
  context: StoryContext,
  mentions: readonly VisualMention[],
): { context: StoryContext; looks: LookFact[] } {
  const visuals = (context.visuals ?? []).map((entity) => ({ ...entity }));
  let facts = context.facts;
  const looks: { index: number; value: string; source: FactSource }[] = [];
  for (const mention of mentions.slice(0, MAX_VISUAL_MENTIONS)) {
    // One time-of-day-and-weather record per project, whatever the model calls it ("Light and weather").
    const conditions = mention.kind === "conditions";
    const name = conditions ? CONDITIONS_NAME : cleanVisualName(mention.name);
    if (!name) continue;
    let index = conditions ? visuals.findIndex((entity) => entity.kind === "conditions") : matchIndex(visuals, name, mention.kind);
    if (index === -1) {
      visuals.push({ name, kind: mention.kind, key: mention.key, ...(mention.central ? { central: true } : {}) });
      index = visuals.length - 1;
    } else {
      const current = visuals[index];
      const longer = !conditions && nameWords(name).length > nameWords(current.name).length;
      const next: VisualEntity = {
        ...current,
        name: longer ? name : current.name,
        key: current.key || mention.key,
        ...(current.central || mention.central ? { central: true } : {}),
      };
      if (longer) facts = relabelLook(facts, current, next);
      visuals[index] = next;
    }
    const value = mention.look.trim().slice(0, MAX_FACT_VALUE);
    if (value && addsToName(value, visuals[index].name)) looks.push({ index, value, source: mention.source });
  }
  const lookFacts = looks.map(({ index, value, source }) => ({
    category: VISUAL_CATEGORY[visuals[index].kind],
    label: visualLabel(visuals[index]),
    value,
    source,
  }));
  const capped = capVisuals(visuals);
  return {
    context: { ...context, facts, ...(capped.length ? { visuals: capped } : {}) },
    looks: lookFacts,
  };
}

export function seedConditions(before: readonly VisualEntity[], context: StoryContext): StoryContext {
  const visuals = context.visuals ?? [];
  const firstPlace = !before.some((entity) => entity.kind === "place") && visuals.some((entity) => entity.kind === "place");
  if (!firstPlace || visuals.some((entity) => entity.kind === "conditions")) return context;
  if (context.facts.some((fact) => fact.category === "lighting" && (fact.source === "user" || fact.approved))) return context;
  return { ...context, visuals: capVisuals([...visuals, { name: CONDITIONS_NAME, kind: "conditions", key: true }]) };
}

export function closeSkipped(context: StoryContext, answeredCount: number, skipped: boolean): StoryContext {
  const visuals = context.visuals;
  if (!skipped || !visuals?.some((entity) => entity.asked === answeredCount - 1)) return context;
  return { ...context, visuals: visuals.map((entity) => (entity.asked === answeredCount - 1 ? { ...entity, closed: true } : entity)) };
}

export function markAsked(context: StoryContext, target: VisualEntity, answeredCount: number): StoryContext {
  return {
    ...context,
    visuals: (context.visuals ?? []).map((entity) => (sameVisual(entity, target) ? { ...entity, asked: answeredCount } : entity)),
  };
}

const KIND_ORDER: Record<VisualKind, number> = { conditions: 0, place: 1, object: 2, character: 3 };

export function openLooks(context: StoryContext): VisualEntity[] {
  const removed = new Set((context.removed ?? []).map((item) => item.key));
  return (context.visuals ?? [])
    .filter(
      (entity) =>
        entity.key &&
        !entity.closed &&
        entity.asked === undefined &&
        !removed.has(visualFactKey(entity)) &&
        visualStatus(context, entity).status !== "confirmed",
    )
    .map((entity, order) => ({ entity, order }))
    .sort(
      (a, b) =>
        Number(Boolean(b.entity.central)) - Number(Boolean(a.entity.central)) ||
        KIND_ORDER[a.entity.kind] - KIND_ORDER[b.entity.kind] ||
        a.order - b.order,
    )
    .map(({ entity }) => entity);
}

const WATER = /^(?:ocean|sea|lake|river|bay|harbou?r|pond|stream|creek|lagoon|canal|waterfall|water|waves?|loch|fjord|gulf|surf)$/;

export function visualHint(entity: Pick<VisualEntity, "name" | "kind">): string {
  if (entity.kind === "conditions") return "time of day, weather, light";
  if (entity.kind === "character") return "clothes, hair, distinguishing look";
  if (entity.kind === "object") return "type, colour, condition";
  return WATER.test(nameWords(entity.name).at(-1) ?? "") ? "water colour and conditions" : "architecture or landscape, colour, condition";
}

const MAX_CHOICE_NAMES = 4;

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function lookChoiceLine(context: StoryContext): string {
  const removed = new Set((context.removed ?? []).map((item) => item.key));
  const open = (context.visuals ?? []).filter((entity) => {
    if (!entity.key || removed.has(visualFactKey(entity))) return false;
    const { status } = visualStatus(context, entity);
    return status === "open" || status === "ai";
  });
  const names = open.filter((entity) => entity.kind !== "conditions").map((entity) => entity.name);
  if (open.some((entity) => entity.kind === "conditions")) names.push("the time of day and weather");
  if (!names.length) return "";
  const shown = names.length > MAX_CHOICE_NAMES ? [...names.slice(0, MAX_CHOICE_NAMES - 1), `${names.length - MAX_CHOICE_NAMES + 1} more`] : names;
  return `I'll choose looks for ${joinNames(shown)}; you can change them in the plan.`;
}
