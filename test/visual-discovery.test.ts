import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type InterviewExchange,
  type InterviewTurnOutput,
  interviewTurnOutput,
  isNearDuplicate,
  resolveInterviewTurn,
  visualGaps,
} from "@/lib/interview";
import { createSession, parseSessions, serializeSessions } from "@/lib/session";
import { composeInstructions, DISCOVERY_STYLE, MEMORY_RULE } from "@/lib/server/prompts";
import {
  approveFact,
  type ContextFact,
  DECIDE_ANSWER,
  EMPTY_CONTEXT,
  editFact,
  factKey,
  isVisualFact,
  MAX_VISUAL_ENTITIES,
  mergeFacts,
  removeFact,
  retractAnswerFacts,
  SKIPPED_ANSWER,
  type StoryContext,
  type VisualEntity,
  visualFactKey,
  withUnresolved,
} from "@/lib/story-context";
import { storyContextSchema } from "@/lib/story-context-schema";
import { parseStoryContext } from "@/lib/studio-agent";
import { CONDITIONS_NAME, lookChoiceLine, MAX_VISUAL_MENTIONS, visualHint } from "@/lib/visual-discovery";

type Mention = InterviewTurnOutput["visuals"][number];

function turn(overrides: Partial<InterviewTurnOutput> = {}): InterviewTurnOutput {
  return {
    note: "",
    complete: false,
    asks: "",
    question: "What does Mara want most?",
    options: [],
    rationale: "",
    recommendation: "",
    facts: [],
    visuals: [],
    unresolved: [],
    ...overrides,
  };
}

const mention = (name: string, kind: Mention["kind"], look = "", overrides: Partial<Mention> = {}): Mention => ({
  name,
  kind,
  key: true,
  central: false,
  look,
  source: "user",
  ...overrides,
});

const userFact = (category: ContextFact["category"], label: string, value: string, extra: Partial<ContextFact> = {}): ContextFact => ({
  category,
  label,
  value,
  source: "user",
  approved: true,
  ...extra,
});

const BASICS: ContextFact[] = [
  userFact("concept", "Premise", "A girl returns to her grandmother's old house."),
  userFact("genre", "Genre", "Ghost story"),
  userFact("format", "Film length", "8 minutes"),
];

const ready = (visuals?: VisualEntity[], facts: ContextFact[] = []): StoryContext => ({
  facts: [...BASICS, ...facts],
  unresolved: [],
  ...(visuals ? { visuals } : {}),
});

const said = (...answers: string[]): InterviewExchange[] =>
  answers.map((answer, index) => ({ question: `Plot question number ${index + 1}?`, answer }));

const factOf = (context: StoryContext, category: ContextFact["category"], label: string) =>
  context.facts.find((fact) => factKey(fact) === factKey({ category, label }));

const names = (context: StoryContext) => (context.visuals ?? []).map((entity) => entity.name);

// --- Looks become ordinary facts ---

test("each look becomes a '<name> look' fact in its kind's category, with the source it was given", () => {
  const resolved = resolveInterviewTurn(
    turn({
      visuals: [
        mention("Old house", "place", "Crumbling white wooden house"),
        mention("Mara", "character", "Yellow raincoat"),
        mention("Red bicycle", "object", "Rusty red bicycle", { source: "ai" }),
        mention("Time of day and weather", "conditions", "Stormy dusk"),
        mention("Garden", "place"),
      ],
    }),
    said("She cycles to the old house."),
    ready(),
  );
  const { context } = resolved;
  assert.deepEqual(factOf(context, "locations", "Old house look"), userFact("locations", "Old house look", "Crumbling white wooden house", { answer: 0 }));
  assert.equal(factOf(context, "characters", "Mara look")?.value, "Yellow raincoat");
  assert.deepEqual(
    [factOf(context, "locations", "Red bicycle look")?.source, factOf(context, "locations", "Red bicycle look")?.approved],
    ["ai", false],
  );
  assert.equal(factOf(context, "lighting", "Time of day and weather")?.value, "Stormy dusk");
  assert.equal(factOf(context, "locations", "Garden look"), undefined, "an empty look adds no fact");
  assert.deepEqual(names(context), ["Old house", "Mara", "Red bicycle", "Time of day and weather", "Garden"]);
  for (const fact of context.facts.filter((item) => item.label.endsWith(" look"))) assert.ok(isVisualFact(context, fact), fact.label);
});

test("a title alone or a You decide answer never makes a look the filmmaker's", () => {
  const look = turn({ visuals: [mention("Lighthouse", "place", "Tall white tower")] });
  const first = resolveInterviewTurn(look, [], EMPTY_CONTEXT, 12, { titleOnly: true });
  assert.deepEqual(
    [factOf(first.context, "locations", "Lighthouse look")?.source, factOf(first.context, "locations", "Lighthouse look")?.approved],
    ["ai", false],
  );
  const decided = resolveInterviewTurn(look, said("A keeper story.", DECIDE_ANSWER), ready());
  assert.equal(factOf(decided.context, "locations", "Lighthouse look")?.source, "ai");
  const skipped = resolveInterviewTurn(look, said("A keeper story.", SKIPPED_ANSWER), ready());
  assert.equal(factOf(skipped.context, "locations", "Lighthouse look")?.source, "ai");
});

test("a model fact with the same key as a look is dropped; other facts still merge", () => {
  const resolved = resolveInterviewTurn(
    turn({
      facts: [
        { category: "locations", label: "Old house look", value: "Spooky", source: "ai" },
        { category: "locations", label: "Town", value: "A fishing town", source: "user" },
      ],
      visuals: [mention("Old house", "place", "Crumbling white wooden house")],
    }),
    said("An old house in a fishing town."),
    ready(),
  );
  const looks = resolved.context.facts.filter((fact) => fact.label === "Old house look");
  assert.deepEqual(
    looks.map((fact) => [fact.value, fact.source]),
    [["Crumbling white wooden house", "user"]],
  );
  assert.equal(factOf(resolved.context, "locations", "Town")?.value, "A fishing town");
});

test("a look never overwrites one the filmmaker gave or approved", () => {
  const context = ready([{ name: "Old house", kind: "place", key: true }], [userFact("locations", "Old house look", "Blue shutters")]);
  const resolved = resolveInterviewTurn(
    turn({ visuals: [mention("Old house", "place", "Grey stone", { source: "ai" })] }),
    said("Yes."),
    context,
  );
  assert.equal(factOf(resolved.context, "locations", "Old house look")?.value, "Blue shutters");
});

// --- One thing, one entry ---

test("'house' and 'Old house' are one thing: the longer name is kept and its look follows it", () => {
  const before = ready([{ name: "House", kind: "place", key: false }], [userFact("locations", "House look", "Peeling paint", { answer: 0 })]);
  const renamed = resolveInterviewTurn(turn({ visuals: [mention("Old house", "place")] }), said("The old house."), before);
  assert.deepEqual(renamed.context.visuals, [{ name: "Old house", kind: "place", key: true }]);
  assert.deepEqual(factOf(renamed.context, "locations", "Old house look"), userFact("locations", "Old house look", "Peeling paint", { answer: 0 }));
  assert.equal(factOf(renamed.context, "locations", "House look"), undefined);

  const shorter = resolveInterviewTurn(
    turn({ visuals: [mention("The house", "place", "Ivy on every wall")] }),
    said("Ivy everywhere."),
    ready([{ name: "Old house", kind: "place", key: true }]),
  );
  assert.deepEqual(names(shorter.context), ["Old house"]);
  assert.equal(factOf(shorter.context, "locations", "Old house look")?.value, "Ivy on every wall");
});

test("different things never merge or overwrite each other's look", () => {
  const two = resolveInterviewTurn(
    turn({
      visuals: [
        mention("Beach house", "place", "Glass walls"),
        mention("Old house", "place", "Crumbling stone"),
        mention("Car", "object", "Black taxi"),
        mention("Car keys", "object", "Brass keys"),
        mention("Mara", "character", "Yellow raincoat"),
        mention("Mara's mother", "character", "Grey coat"),
      ],
    }),
    said("Two houses."),
    ready(),
  );
  assert.deepEqual(names(two.context).slice(0, 6), ["Beach house", "Old house", "Car", "Car keys", "Mara", "Mara's mother"]);
  assert.equal(factOf(two.context, "locations", "Beach house look")?.value, "Glass walls");
  assert.equal(factOf(two.context, "locations", "Old house look")?.value, "Crumbling stone");

  const ambiguous = resolveInterviewTurn(turn({ visuals: [mention("house", "place", "Tiny")] }), said("Tiny."), two.context);
  assert.equal(factOf(ambiguous.context, "locations", "Beach house look")?.value, "Glass walls");
  assert.equal(factOf(ambiguous.context, "locations", "Old house look")?.value, "Crumbling stone");

  const person = resolveInterviewTurn(
    turn({ visuals: [mention("Mara Cole", "character", "Short black hair")] }),
    said("Her name is Mara Cole."),
    ready([{ name: "Mara", kind: "character", key: true }]),
  );
  assert.deepEqual(names(person.context), ["Mara Cole"]);
});

test("at most 12 things are tracked: minor ones go first, key ones stay", () => {
  const places: VisualEntity[] = Array.from({ length: 10 }, (_, index) => ({ name: `Room ${index + 1}`, kind: "place", key: true }));
  const context = ready([...places, { name: "Teacup", kind: "object", key: false }]);
  const resolved = resolveInterviewTurn(
    turn({
      visuals: [
        mention("Music box", "object"),
        mention("Lamp", "object", "", { key: false }),
        mention("Sword", "object"),
      ],
    }),
    said("More things."),
    context,
  );
  assert.equal(resolved.context.visuals?.length, MAX_VISUAL_ENTITIES);
  assert.ok(resolved.context.visuals?.every((entity) => entity.key));
  assert.deepEqual(names(resolved.context).slice(-2), ["Music box", "Sword"]);
});

test("the first place seeds one 'Time of day and weather' look, unless the filmmaker already set the light", () => {
  const first = resolveInterviewTurn(turn({ visuals: [mention("Harbour", "place")] }), said("A harbour."), ready());
  assert.deepEqual(first.context.visuals, [
    { name: "Harbour", kind: "place", key: true },
    { name: CONDITIONS_NAME, kind: "conditions", key: true },
  ]);
  const second = resolveInterviewTurn(turn({ visuals: [mention("Market", "place")] }), said("A harbour.", "And a market."), first.context);
  assert.equal(second.context.visuals?.filter((entity) => entity.kind === "conditions").length, 1);

  const lit = ready(undefined, [userFact("lighting", "Light", "Cold blue night")]);
  const noSeed = resolveInterviewTurn(turn({ visuals: [mention("Harbour", "place")] }), said("A harbour."), lit);
  assert.deepEqual(names(noSeed.context), ["Harbour"]);
  const approved = ready(undefined, [{ ...userFact("lighting", "Light", "Dawn"), source: "ai" }]);
  assert.deepEqual(names(resolveInterviewTurn(turn({ visuals: [mention("Harbour", "place")] }), said("x"), approved).context), ["Harbour"]);
  const suggested = ready(undefined, [{ ...userFact("lighting", "Light", "Dawn"), source: "ai", approved: false }]);
  assert.equal(resolveInterviewTurn(turn({ visuals: [mention("Harbour", "place")] }), said("x"), suggested).context.visuals?.length, 2);
});

test("names are clipped so the saved context always stays valid", () => {
  const long = `${"Very ".repeat(20)}old house`;
  const resolved = resolveInterviewTurn(turn({ visuals: [mention(long, "place", "Huge")] }), said("x"), ready());
  assert.ok(storyContextSchema.safeParse(resolved.context).success);
  assert.ok((resolved.context.visuals?.[0].name.length ?? 0) <= 60);
  assert.equal(resolveInterviewTurn(turn({ visuals: [mention("   ", "place", "Nothing")] }), said("x"), ready()).context.visuals, undefined);
});

// --- Gaps ---

const FIVE: VisualEntity[] = [
  { name: "Mara", kind: "character", key: true },
  { name: "Harbour", kind: "place", key: true },
  { name: "Boat", kind: "object", key: true },
  { name: "Gull", kind: "object", key: false },
  { name: CONDITIONS_NAME, kind: "conditions", key: true },
];

const gapNames = (context: StoryContext, answered: InterviewExchange[] = []) => visualGaps(context, answered).gaps.map((entity) => entity.name);

test("gaps are listed even before genre and format are set (the prompt gates the asking); order conditions, places, objects, characters", () => {
  assert.deepEqual(gapNames({ facts: BASICS.slice(0, 2), unresolved: [], visuals: FIVE }), [CONDITIONS_NAME, "Harbour", "Boat", "Mara"]);
  assert.deepEqual(gapNames(ready(FIVE)), [CONDITIONS_NAME, "Harbour", "Boat", "Mara"]);
  assert.equal(visualGaps(ready(FIVE), []).left, 3);
  const central = FIVE.map((entity) => (entity.name === "Mara" ? { ...entity, central: true } : entity));
  assert.deepEqual(gapNames(ready(central)), ["Mara", CONDITIONS_NAME, "Harbour", "Boat"]);
});

test("an AI-only look is still a gap; confirmed, removed, asked and closed ones are not", () => {
  const aiLook = ready(FIVE, [{ category: "locations", label: "Harbour look", value: "Grey", source: "ai", approved: false }]);
  assert.ok(gapNames(aiLook).includes("Harbour"));
  const approvedLook = ready(FIVE, [{ category: "locations", label: "Harbour look", value: "Grey", source: "ai", approved: true }]);
  assert.ok(!gapNames(approvedLook).includes("Harbour"));
  const userLook = ready(FIVE, [userFact("characters", "Mara look", "Red scarf")]);
  assert.ok(!gapNames(userLook).includes("Mara"));
  const removed = { ...ready(FIVE), removed: [{ key: visualFactKey({ name: "Boat", kind: "object" }), value: "Old" }] };
  assert.ok(!gapNames(removed).includes("Boat"));
  const asked = ready(FIVE.map((entity) => (entity.name === "Boat" ? { ...entity, asked: 0 } : entity)));
  assert.deepEqual(gapNames(asked), [CONDITIONS_NAME, "Harbour", "Mara"]);
  assert.equal(visualGaps(asked, []).left, 2);
  const closed = ready(FIVE.map((entity) => (entity.name === "Harbour" ? { ...entity, asked: 0, closed: true } : entity)));
  assert.ok(!gapNames(closed).includes("Harbour"));
});

test("three look questions at most, plus one for the thing the story revolves around", () => {
  const extra: VisualEntity[] = [
    { name: "Dock", kind: "place", key: true, asked: 0 },
    { name: "Net", kind: "object", key: true, asked: 1 },
    { name: "Coat", kind: "object", key: true, asked: 2 },
  ];
  assert.deepEqual(visualGaps(ready([...extra, ...FIVE]), said("a", "b", "c")), { left: 0, gaps: [] });

  const centralOpen = [...extra, ...FIVE.map((entity) => (entity.name === "Boat" ? { ...entity, central: true } : entity))];
  assert.deepEqual(visualGaps(ready(centralOpen), said("a", "b", "c")), { left: 1, gaps: [centralOpen[5]] });

  const centralAsked = [...extra.map((entity) => (entity.name === "Dock" ? { ...entity, central: true } : entity)), ...FIVE];
  assert.equal(visualGaps(ready(centralAsked), said("a", "b", "c")).left, 1);
  const fourth = centralAsked.map((entity) => (entity.name === "Mara" ? { ...entity, asked: 3 } : entity));
  assert.deepEqual(visualGaps(ready(fourth), said("a", "b", "c", "d")), { left: 0, gaps: [] });

  assert.equal(visualGaps(ready(FIVE), said(...Array.from({ length: 11 }, () => "x"))).left, 1);
  assert.equal(visualGaps(ready(FIVE), said(...Array.from({ length: 12 }, () => "x"))).left, 0);
});

test("each kind gets its own hint, worked out in code", () => {
  assert.equal(visualHint({ name: "Old house", kind: "place" }), "architecture or landscape, colour, condition");
  assert.equal(visualHint({ name: "Beach house", kind: "place" }), "architecture or landscape, colour, condition");
  assert.equal(visualHint({ name: "The ocean", kind: "place" }), "water colour and conditions");
  assert.equal(visualHint({ name: "Mara", kind: "character" }), "clothes, hair, distinguishing look");
  assert.equal(visualHint({ name: "Red bicycle", kind: "object" }), "type, colour, condition");
  assert.equal(visualHint({ name: CONDITIONS_NAME, kind: "conditions" }), "time of day, weather, light");
});

// --- Turn handling ---

test("asks marks the thing as asked on this turn; asking about it again ends discovery", () => {
  const context = ready([{ name: "Old house", kind: "place", key: true }]);
  const asked = resolveInterviewTurn(
    turn({ asks: "Old house", question: "What is the old house like when Mara gets there?", options: ["Crumbling white wooden house"] }),
    said("a", "b"),
    context,
  );
  assert.equal(asked.status, "ask");
  assert.equal(asked.context.visuals?.[0].asked, 2);
  assert.equal(visualGaps(asked.context, said("a", "b", "c")).left, 2);

  const again = resolveInterviewTurn(
    turn({ asks: "old house", question: "How should the house's paint look?" }),
    said("a", "b", "Crumbling"),
    asked.context,
  );
  assert.equal(again.status, "complete");
  assert.equal(again.context.visuals?.[0].asked, 2);
});

test("look questions about different things are not duplicates; a reworded story question still is", () => {
  const previous = { question: "What does the beach house look like?", answer: "Glass walls" };
  assert.ok(isNearDuplicate("What does the house look like?", [previous.question]), "the bug this guards against");
  const context = ready([
    { name: "Beach house", kind: "place", key: true, asked: 0 },
    { name: "House", kind: "place", key: true },
  ]);
  const house = resolveInterviewTurn(turn({ asks: "House", question: "What does the house look like?" }), [previous], context);
  assert.equal(house.status, "ask");
  assert.equal(house.context.visuals?.[1].asked, 1);

  const inferred = resolveInterviewTurn(turn({ question: "What does the house look like?" }), [previous], context);
  assert.equal(inferred.status, "ask", "an empty asks is read from the question, so the open House gap is asked");
  assert.equal(inferred.context.visuals?.[1].asked, 1);
  const reworded = resolveInterviewTurn(
    turn({ question: "Who's the main character?" }),
    [{ question: "Who is the main character?", answer: "Mara" }],
    context,
  );
  assert.equal(reworded.status, "complete");
});

test("Skip closes the thing asked about last turn", () => {
  const context = ready([
    { name: "Old house", kind: "place", key: true, asked: 1 },
    { name: "Mara", kind: "character", key: true },
  ]);
  const skipped = resolveInterviewTurn(turn(), said("a", SKIPPED_ANSWER), context);
  assert.deepEqual(skipped.context.visuals?.[0], { name: "Old house", kind: "place", key: true, asked: 1, closed: true });
  assert.equal(skipped.context.visuals?.[1].closed, undefined);
  const answered = resolveInterviewTurn(turn(), said("a", "Crumbling"), context);
  assert.equal(answered.context.visuals?.[0].closed, undefined);
});

test("a central mention is remembered", () => {
  const resolved = resolveInterviewTurn(turn({ visuals: [mention("Old house", "place", "", { central: true })] }), said("x"), ready());
  assert.equal(resolved.context.visuals?.[0].central, true);
});

test("completing with key looks still open says the AI will choose them", () => {
  const context = ready(
    [
      { name: "Old house", kind: "place", key: true },
      { name: "Mara", kind: "character", key: true },
      { name: "Gull", kind: "object", key: false },
      { name: "Boat", kind: "object", key: true, asked: 0, closed: true },
      { name: CONDITIONS_NAME, kind: "conditions", key: true },
    ],
    [userFact("characters", "Mara look", "Yellow raincoat")],
  );
  const done = resolveInterviewTurn(turn({ complete: true, question: "", recommendation: "Start planning." }), said("a"), context);
  assert.equal(
    done.status === "complete" && done.recommendation,
    "Start planning. I'll choose looks for Old house and the time of day and weather; you can change them in the plan.",
  );
  const fallback = resolveInterviewTurn(turn({ complete: true, question: "" }), said("a"), context);
  assert.ok(fallback.status === "complete" && fallback.recommendation.endsWith("you can change them in the plan."));
  const none = resolveInterviewTurn(turn({ complete: true, question: "", recommendation: "Start planning." }), said("a"), ready());
  assert.equal(none.status === "complete" && none.recommendation, "Start planning.");
  const many = ready(Array.from({ length: 6 }, (_, index): VisualEntity => ({ name: `Room ${index + 1}`, kind: "place", key: true })));
  assert.equal(lookChoiceLine(many), "I'll choose looks for Room 1, Room 2, Room 3 and 3 more; you can change them in the plan.");
});

// --- Round trip ---

const SAVED: StoryContext = {
  facts: [...BASICS, userFact("locations", "Old house look", "Blue shutters", { answer: 1 })],
  unresolved: ["Why does Mara return?"],
  removed: [{ key: "locations:garden look", value: "Overgrown" }],
  visuals: [
    { name: "Old house", kind: "place", key: true, asked: 1, central: true },
    { name: "Mara", kind: "character", key: true, closed: true, asked: 2 },
    { name: CONDITIONS_NAME, kind: "conditions", key: true },
  ],
};

test("visuals survive every context change and the trip through the client", () => {
  const changes: StoryContext[] = [
    mergeFacts(SAVED, [userFact("sound", "Music", "Piano")]),
    withUnresolved(SAVED, ["New gap"]),
    removeFact(SAVED, factKey({ category: "genre", label: "Genre" })),
    editFact(SAVED, factKey({ category: "genre", label: "Genre" }), "Folk horror"),
    retractAnswerFacts(SAVED, 1),
    approveFact(SAVED, factKey({ category: "genre", label: "Genre" })),
    parseStoryContext(JSON.parse(JSON.stringify(SAVED))) ?? EMPTY_CONTEXT,
  ];
  for (const [index, changed] of changes.entries()) assert.deepEqual(changed.visuals, SAVED.visuals, `change ${index}`);
  assert.deepEqual(parseStoryContext(JSON.parse(JSON.stringify(SAVED))), SAVED);
  assert.equal(mergeFacts(EMPTY_CONTEXT, []).visuals, undefined);
});

test("the client drops only a bad visual entry, and old contexts without visuals load unchanged", () => {
  const parsed = parseStoryContext({
    facts: [],
    unresolved: [],
    visuals: [
      { name: "Old house", kind: "place", key: true },
      { name: "", kind: "place", key: true },
      { name: "Moon", kind: "planet", key: true },
      "junk",
      { name: "x".repeat(61), kind: "place", key: true },
      { name: "Mara", kind: "character" },
    ],
  });
  assert.deepEqual(parsed, { facts: [], unresolved: [], visuals: [{ name: "Old house", kind: "place", key: true }] });
  assert.deepEqual(parseStoryContext({ facts: [], unresolved: [] }), { facts: [], unresolved: [] });
  assert.deepEqual(parseStoryContext({ facts: [], unresolved: [], visuals: "nope" }), { facts: [], unresolved: [] });
});

test("saved sessions with and without visuals both load", () => {
  const old = { ...createSession("Old"), context: { facts: BASICS, unresolved: [] } };
  const current = { ...createSession("New"), context: SAVED };
  const loaded = parseSessions(JSON.stringify(serializeSessions([old, current], current.id)));
  assert.equal(loaded.sessions.length, 2);
  assert.equal(loaded.sessions[0].context?.visuals, undefined);
  assert.deepEqual(loaded.sessions[1].context?.visuals, SAVED.visuals);
});

// --- Contract and brain ---

test("the interview output requires visuals and asks, with known kinds only", () => {
  const { visuals: _visuals, ...noVisuals } = turn();
  const { asks: _asks, ...noAsks } = turn();
  assert.equal(interviewTurnOutput.safeParse(noVisuals).success, false);
  assert.equal(interviewTurnOutput.safeParse(noAsks).success, false);
  assert.equal(interviewTurnOutput.safeParse(turn({ visuals: [mention("Moon", "planet" as Mention["kind"])] })).success, false);
  assert.equal(interviewTurnOutput.safeParse(turn({ visuals: [mention("Old house", "place", "Grey")] })).success, true);
});

test("the brain asks for looks in visuals and plans from them", () => {
  const interview = composeInstructions("interview", "short_film");
  assert.ok(interview.includes("and VISUAL GAPS (looks still open)"));
  assert.ok(interview.includes(`at most ${MAX_VISUAL_MENTIONS}, named as the story names them`));
  assert.ok(interview.includes("set asks to that line's name"));
  assert.ok(interview.includes("Put a look in visuals only, never in facts."));
  assert.ok(interview.includes("to asking, except looks (below)."));
  assert.ok(interview.includes("VISUAL GAPS is absent or shows no look questions left, stop:"));
  assert.ok(interview.includes("including how its main places and light look."));
  assert.ok(DISCOVERY_STYLE.includes("things a camera can see (Crumbling white wooden house, Misty dawn), not feelings (Spooky)"));
  assert.ok(MEMORY_RULE.includes('Labels ending in "look" say how that place, character or object looks'));
  assert.ok(composeInstructions("plan_outline", "short_film").includes("Looks: write each place's description and each character's look"));
  assert.ok(composeInstructions("plan_outline", "short_film").includes(MEMORY_RULE));
  assert.ok(composeInstructions("plan_scene", "short_film").includes("The first shot's action opens with the scene's time of day, weather"));
  assert.ok(composeInstructions("edit_scene", "short_film").includes("Keep places, characters and objects looking as OVERVIEW describes"));
});

test("a look that only repeats the thing's own name is not a look", async () => {
  const { addsToName, trackVisuals } = await import("../src/lib/visual-discovery.ts");
  assert.equal(addsToName("old", "Old house"), false);
  assert.equal(addsToName("It's old", "old house"), false);
  assert.equal(addsToName("Dark", "dark forest"), false);
  assert.equal(addsToName("grey stone, boarded windows", "Old house"), true);
  assert.equal(addsToName("old and crumbling", "Old house"), true);
  const tracked = trackVisuals({ facts: [], unresolved: [] }, [
    { name: "old house", kind: "place", key: true, central: true, look: "old", source: "user" },
    { name: "forest", kind: "place", key: true, central: false, look: "dark and really dense", source: "user" },
  ]);
  assert.deepEqual(tracked.looks.map((look) => look.label), ["forest look"]);
});

test("an empty asks is read from the question: look cue + the open gap mentioned first; story questions are not look questions", async () => {
  const { inferAsks } = await import("../src/lib/visual-discovery.ts");
  const gaps = [
    { name: "Time of day and weather", kind: "conditions" as const, key: true },
    { name: "old house", kind: "place" as const, key: true, central: true },
    { name: "forest", kind: "place" as const, key: true },
    { name: "mother's letters", kind: "object" as const, key: true },
  ];
  assert.equal(inferAsks("Why has the protagonist come to the old house?", gaps), undefined);
  assert.equal(inferAsks("What does the old house look like from the forest path?", gaps)?.name, "old house");
  assert.equal(inferAsks("What are the light and weather like when she first sees the old house?", gaps)?.kind, "conditions");
  assert.equal(inferAsks("What does the forest look like on the walk to the house?", gaps)?.name, "forest");
  assert.equal(inferAsks("What do the mother's letters look like?", gaps)?.name, "mother's letters");
});

test("conditions mentions always land on the one Time of day and weather record", async () => {
  const { trackVisuals, CONDITIONS_NAME } = await import("../src/lib/visual-discovery.ts");
  const first = trackVisuals({ facts: [], unresolved: [], visuals: [{ name: CONDITIONS_NAME, kind: "conditions", key: true }] }, [
    { name: "Light and weather", kind: "conditions", key: true, central: false, look: "Late afternoon drizzle under a pale grey sky", source: "ai" },
  ]);
  assert.deepEqual(first.context.visuals?.map((entity) => entity.name), [CONDITIONS_NAME]);
  assert.deepEqual(first.looks.map((look) => [look.category, look.label]), [["lighting", CONDITIONS_NAME]]);
});
