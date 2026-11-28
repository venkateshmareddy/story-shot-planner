import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTranscript } from "../src/lib/transcript-cleanup.ts";

const NO_NAMES = { names: [] };
const clean = (text: string, names: string[] = []) => cleanTranscript(text, { names });

test("the live probe sentence: filler removed, next word capitalised, near-miss name fixed, nothing else changed", () => {
  assert.equal(
    clean(
      "Ashwin walks through the dark forest at stormy dusk. Um, the camera starts on a wide shot, then a slow dolly in to a close-up of the old house.",
      ["Aswin"],
    ),
    "Aswin walks through the dark forest at stormy dusk. The camera starts on a wide shot, then a slow dolly in to a close-up of the old house.",
  );
});

test("standalone fillers go with their pause punctuation; the punctuation before them stays", () => {
  const cases: [string, string][] = [
    ["Um, the camera pans left.", "The camera pans left."],
    ["umm the camera pans left.", "The camera pans left."],
    ["Uh, uhh, the camera pans left.", "The camera pans left."],
    ["Then the, er, camera pans left.", "Then the, camera pans left."],
    ["Then the camera erm pans left.", "Then the camera pans left."],
    ["Mara, um, Ravi and Pier walk in.", "Mara, Ravi and Pier walk in."],
    ["I think um, we cut here.", "I think we cut here."],
    ["We hold on the door, hmm.", "We hold on the door."],
    ["We hold on the door mm", "We hold on the door"],
    ["We hold on the door. Hmm. Then we cut.", "We hold on the door. Then we cut."],
    ["Hmm. Then we cut.", "Then we cut."],
    ["Um... the camera pans left.", "The camera pans left."],
    ["Um… the camera pans left.", "The camera pans left."],
    ["She walks — um — into the room.", "She walks — into the room."],
    ["Fade in.\n\nUm, the camera pans left.", "Fade in.\n\nThe camera pans left."],
    ['"Um, the camera pans left," she says.', '"The camera pans left," she says.'],
    ['She says "um, wait" and leaves.', 'She says "wait" and leaves.'],
    ["Is this the take? Uh, it is the take.", "Is this the take? It is the take."],
    ["UM, the camera pans.", "UM, the camera pans."],
  ];
  for (const [input, expected] of cases) assert.equal(clean(input), expected, input);
});

test("words that merely contain a filler, uppercase acronyms and millimetres are never touched", () => {
  const untouched = [
    "The umbrella opens in the summer rain.",
    "She hummed and the hummingbird left the room.",
    "Uhura and Erma meet at the ER with Hmmingway.",
    "Shot it on a 35 mm lens with the 50 mm prime.",
    "Mm-hmm, he says, and uh-huh, she replies.",
    "The error was the umpire's call.",
  ];
  for (const text of untouched) assert.equal(clean(text), text, text);
});

test("an immediately repeated word collapses once; meaningful doubles and names stay", () => {
  assert.equal(clean("the the camera pans left."), "the camera pans left.");
  assert.equal(clean("The the camera pans to the the door."), "The camera pans to the door.");
  assert.equal(clean("and and and then we cut."), "and then we cut.");
  assert.equal(clean("We cut to the  the door."), "We cut to the door.");
  const untouched = [
    "She had had enough of the rain.",
    "I know that that is the plan.",
    "It is very very dark in the hall.",
    "They fly to Bora Bora for the shoot.",
    "We cut to the, the door.",
    "The year is twenty twenty in this scene.",
    "The thermos and theme of the film.",
  ];
  for (const text of untouched) assert.equal(clean(text), text, text);
});

test("near-miss names take the hint spelling: one edit for short names, two for long ones, same first sound", () => {
  assert.equal(clean("Then Ashwin runs to the pier.", ["Aswin"]), "Then Aswin runs to the pier.");
  assert.equal(clean("Ashwin's camera rolls at the pier.", ["Aswin"]), "Aswin's camera rolls at the pier.");
  assert.equal(clean("We follow Katherinne to the pier.", ["Catherine"]), "We follow Catherine to the pier.");
  assert.equal(clean("We follow Filippa to the pier.", ["Philippa"]), "We follow Philippa to the pier.");
  assert.equal(clean("The boat leaves North Peer at dawn.", ["North Pier"]), "The boat leaves North Pier at dawn.");
  assert.equal(clean("We see Jose at the pier.", ["José"]), "We see José at the pier.");
  assert.equal(clean("We see Mara at the pier.", ["Mara", "Maria"]), "We see Mara at the pier.");
});

test("names are never changed when the match is ambiguous, too far, a common word, lowercase or a short name", () => {
  const cases: [string, string[]][] = [
    ["Then Ashwin runs to the pier.", ["Aswin", "Ashwan"]],
    ["Then Ashwiin runs to the pier.", ["Aswin"]],
    ["Then Bashwin runs to the pier.", ["Aswin"]],
    ["Mark the spot where she stands.", ["Mara"]],
    ["Rise and shine, the camera rolls.", ["Rose"]],
    ["They mark the spot at the pier.", ["Mara"]],
    ["We rise at the pier with the crew.", ["Rose"]],
    ["Then Ivan walks to the pier.", ["Ian"]],
    ["Then Ravis walk to the pier.", ["Ravi"]],
    ["Then ASHWIN runs to the pier.", ["Aswin"]],
    ["Then Ashwin runs to the pier.", []],
  ];
  for (const [text, names] of cases) assert.equal(clean(text, names), text, `${text} ${names.join(",")}`);
});

test("the cleanup never adds words and leaves non-English transcripts exactly as returned", () => {
  const input = "Um, the the camera finds Ashwin at the pier, uh, at dusk.";
  const output = clean(input, ["Aswin"]);
  assert.equal(output, "The camera finds Aswin at the pier, at dusk.");
  const words = (text: string) => text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  for (const word of words(output)) assert.ok(words(input).includes(word) || word === "aswin", word);

  const foreign = [
    "Er geht um acht Uhr nach Hause und sie ist nicht da.",
    "Ele tem um carro e uma casa com a família.",
    "Nous nous levons tôt et la caméra est prête.",
    "Hij zegt dat er een man bij de deur staat.",
  ];
  for (const text of foreign) assert.equal(clean(text, ["Hans", "Mara"]), text, text);
  assert.equal(cleanTranscript("  अश्विन जंगल में चलता है।  ", NO_NAMES), "अश्विन जंगल में चलता है।");
});

test("empty, filler-only and whitespace transcripts become empty", () => {
  assert.equal(clean(""), "");
  assert.equal(clean("   "), "");
  assert.equal(clean("Um."), "");
  assert.equal(clean("Um, hmm."), "");
  assert.equal(clean("uh"), "");
});
