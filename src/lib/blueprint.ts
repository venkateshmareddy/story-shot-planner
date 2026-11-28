import {
  type ImageReference,
  type Recommendation,
  type RecommendationPriority,
  SPECIALIST_IDS,
  SPECIALIST_LABELS,
} from "@/lib/agents/types";
import { lookCollectedLabels, lookExportItems } from "@/lib/look-and-feel";
import type { StorySession } from "@/lib/session";
import type { ShotPlan } from "@/lib/story-planning";

export type BlueprintStatus = "Draft" | "Final";

export type BlueprintField = { label: string; value: string };
export type BlueprintListItem = { lead?: string; text: string };

export type BlueprintShot = {
  id: string;
  length: string;
  framing: string;
  camera: string;
  action: string;
  who: string;
  place: string;
  feeling: string;
  sound: string;
  dialogue: string[];
};

export type BlueprintScene = { id: string; title: string; length: string; shots: BlueprintShot[] };

export type BlueprintBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "fields"; fields: BlueprintField[] }
  | { kind: "list"; items: BlueprintListItem[] }
  | { kind: "scene"; scene: BlueprintScene };

export type BlueprintSectionId =
  | "summary"
  | "about"
  | "known"
  | "looks"
  | "characters"
  | "places"
  | "scenes"
  | "changes"
  | "advice"
  | "references"
  | "checks"
  | "answers";

export type BlueprintSection = { id: BlueprintSectionId; heading: string; blocks: BlueprintBlock[] };

export type Blueprint = {
  title: string;
  status: BlueprintStatus;
  dateLabel: string;
  /** Running header: "DRAFT" or "FINAL — <date>". */
  headerLabel: string;
  runtimeSeconds: number;
  runtimeLabel: string;
  hasPlan: boolean;
  notice: string | null;
  sections: BlueprintSection[];
};

export type BlueprintOptions = { final: boolean; date: Date };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const PRIORITY_ORDER: Record<RecommendationPriority, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABELS: Record<RecommendationPriority, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

export function canExportFinal(session: Pick<StorySession, "plan">): boolean {
  return session.plan?.scenes.some((scene) => scene.shots.length > 0) === true;
}

export function formatDateLabel(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function clean(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function safeSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
}

function formatSeconds(seconds: number): string {
  const safe = safeSeconds(seconds);
  const rounded = Math.round(safe * 10) / 10;
  if (rounded < 60) return `${rounded} s`;
  const whole = Math.round(safe);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function shotSeconds(plan: ShotPlan | null): number {
  if (!plan) return 0;
  return plan.scenes.reduce((total, scene) => total + scene.shots.reduce((sum, shot) => sum + safeSeconds(shot.seconds), 0), 0);
}

function pad(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function fields(entries: [string, string | undefined][]): BlueprintField[] {
  return entries.map(([label, value]) => ({ label, value: clean(value) })).filter((field) => field.value);
}

function textItems(values: string[]): BlueprintListItem[] {
  return values.map(clean).filter(Boolean).map((text) => ({ text }));
}

function paragraph(text: string | undefined): BlueprintBlock[] {
  const value = clean(text);
  return value ? [{ kind: "paragraph", text: value }] : [];
}

function nonEmpty(blocks: BlueprintBlock[]): BlueprintBlock[] {
  return blocks.filter((block) => {
    if (block.kind === "fields") return block.fields.length > 0;
    if (block.kind === "list") return block.items.length > 0;
    return true;
  });
}

function charactersSection(plan: ShotPlan): BlueprintBlock[] {
  return plan.characters.flatMap((character): BlueprintBlock[] => {
    const name = clean(character.name);
    if (!name) return [];
    const role = clean(character.role);
    return [
      { kind: "subheading", text: role ? `${name} (${role})` : name },
      {
        kind: "fields",
        fields: fields([
          ["Look", character.look],
          ["Personality", character.personality],
          ["Voice", character.voice],
        ]),
      },
    ];
  });
}

function scenesSection(plan: ShotPlan, runtimeLabel: string): BlueprintBlock[] {
  const shotCount = plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
  if (shotCount === 0 && plan.scenes.length === 0) return [];
  const scenes = plan.scenes.map((scene, sceneIndex): BlueprintBlock => {
    const shots = scene.shots.map(
      (shot, shotIndex): BlueprintShot => ({
        id: `S${pad(sceneIndex)}_SH${pad(shotIndex)}`,
        length: formatSeconds(shot.seconds),
        framing: clean(shot.framing),
        camera: clean(shot.camera),
        action: clean(shot.action),
        who: shot.characters.map(clean).filter(Boolean).join(", "),
        place: clean(shot.location),
        feeling: clean(shot.emotion),
        sound: clean(shot.sound),
        dialogue: shot.dialogue
          .map((line) => {
            const speaker = clean(line.speaker) || "Someone";
            const text = clean(line.line);
            const delivery = clean(line.delivery);
            if (!text) return "";
            return delivery ? `${speaker}: ${text} (${delivery})` : `${speaker}: ${text}`;
          })
          .filter(Boolean),
      }),
    );
    const seconds = scene.shots.reduce((sum, shot) => sum + safeSeconds(shot.seconds), 0);
    return {
      kind: "scene",
      scene: { id: `S${pad(sceneIndex)}`, title: clean(scene.title) || `Scene ${sceneIndex + 1}`, length: formatSeconds(seconds), shots },
    };
  });
  const sceneWord = plan.scenes.length === 1 ? "scene" : "scenes";
  const shotWord = shotCount === 1 ? "shot" : "shots";
  return [
    { kind: "paragraph", text: `${plan.scenes.length} ${sceneWord}, ${shotCount} ${shotWord}, about ${runtimeLabel} in total.` },
    ...scenes,
  ];
}

function knownFields(session: StorySession): BlueprintField[] {
  const looks = lookCollectedLabels(session.context);
  return fields(
    session.collected
      .filter((item) => !looks.has(item.label))
      .map((item): [string, string] => [clean(item.label) || "Detail", item.detail]),
  );
}

function looksSection(session: StorySession): BlueprintBlock[] {
  return [
    {
      kind: "list",
      items: lookExportItems(session.context)
        .map((item) => ({ lead: clean(item.lead), text: clean(item.text) }))
        .filter((item) => item.lead && item.text),
    },
  ];
}

function approvedChanges(session: StorySession): BlueprintListItem[] {
  return textItems(
    session.messages.flatMap((message) =>
      message.role === "agent" && message.status === "accepted" ? (message.changeSummary ?? []) : [],
    ),
  );
}

function recommendationKey(item: Recommendation): string {
  return [item.specialist, clean(item.target), clean(item.recommendation)].join("|").toLowerCase();
}

function adviceSection(session: StorySession): BlueprintBlock[] {
  const seen = new Set<string>();
  const recommendations: Recommendation[] = [];
  const conflicts: string[] = [];
  for (const message of session.messages) {
    if (message.role !== "agent") continue;
    for (const item of message.recommendations ?? []) {
      const key = recommendationKey(item);
      if (seen.has(key) || !clean(item.recommendation)) continue;
      seen.add(key);
      recommendations.push(item);
    }
    for (const conflict of message.conflicts ?? []) {
      const text = clean(conflict);
      if (text && !conflicts.includes(text)) conflicts.push(text);
    }
  }
  if (recommendations.length === 0 && conflicts.length === 0) return [];

  const blocks: BlueprintBlock[] = [
    {
      kind: "paragraph",
      text: "These are suggestions only. They have not been applied to the plan unless they also appear under Approved changes.",
    },
  ];
  for (const specialist of SPECIALIST_IDS) {
    const group = recommendations
      .filter((item) => item.specialist === specialist)
      .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
    if (group.length === 0) continue;
    blocks.push({ kind: "subheading", text: `${SPECIALIST_LABELS[specialist]} advice` });
    blocks.push({
      kind: "list",
      items: group.map((item) => {
        const target = clean(item.target);
        const priority = PRIORITY_LABELS[item.priority] ?? "Suggestion";
        const parts = [
          clean(item.issue),
          `Suggestion: ${clean(item.recommendation)}`,
          clean(item.rationale) ? `Why: ${clean(item.rationale)}` : "",
        ].filter(Boolean);
        return { lead: target ? `${priority}, ${target}` : priority, text: parts.join(" ") };
      }),
    });
  }
  if (conflicts.length > 0) {
    blocks.push({ kind: "subheading", text: "Where the team disagrees" });
    blocks.push({ kind: "list", items: conflicts.map((text) => ({ text })) });
  }
  return blocks;
}

function collectReferences(session: StorySession): ImageReference[] {
  const byId = new Map<string, ImageReference>();
  for (const reference of session.references ?? []) byId.set(reference.id, reference);
  for (const message of session.messages) {
    if (message.reference && !byId.has(message.reference.id)) byId.set(message.reference.id, message.reference);
  }
  return [...byId.values()];
}

function referencesSection(session: StorySession): BlueprintBlock[] {
  return collectReferences(session).flatMap((reference, index): BlueprintBlock[] => [
    { kind: "subheading", text: clean(reference.name) || `Reference ${index + 1}` },
    ...paragraph(reference.summary),
    {
      kind: "fields",
      fields: fields([
        ["Composition", reference.composition],
        ["Lighting", reference.lighting],
        ["Camera angle", reference.cameraAngle],
        ["Colour", reference.colour],
        ["Setting", reference.environment],
        ["Mood", reference.mood],
        ["Shot ideas", reference.shotIdeas],
      ]),
    },
  ]);
}

export function buildBlueprint(session: StorySession, options: BlueprintOptions): Blueprint {
  const plan = session.plan;
  if (options.final && !canExportFinal(session)) {
    throw new Error("A final blueprint needs a shot plan with at least one shot.");
  }
  const status: BlueprintStatus = options.final ? "Final" : "Draft";
  const dateLabel = formatDateLabel(options.date);
  const runtimeSeconds = shotSeconds(plan);
  const runtimeLabel = formatSeconds(runtimeSeconds);

  const candidates: BlueprintSection[] = [
    { id: "summary", heading: "One-line summary", blocks: paragraph(plan?.logline) },
    { id: "about", heading: "What the film is about", blocks: paragraph(plan?.intent) },
    {
      id: "known",
      heading: "What we know so far",
      blocks: [{ kind: "fields", fields: knownFields(session) }],
    },
    { id: "looks", heading: "Look and feel", blocks: looksSection(session) },
    { id: "characters", heading: "Characters", blocks: plan ? charactersSection(plan) : [] },
    {
      id: "places",
      heading: "Places",
      blocks: plan
        ? [{ kind: "fields", fields: fields(plan.locations.map((place) => [clean(place.name) || "Place", place.description])) }]
        : [],
    },
    { id: "scenes", heading: "Scenes and shots", blocks: plan ? scenesSection(plan, runtimeLabel) : [] },
    { id: "changes", heading: "Approved changes", blocks: [{ kind: "list", items: approvedChanges(session) }] },
    { id: "advice", heading: "Advice from the film team", blocks: adviceSection(session) },
    { id: "references", heading: "Reference images", blocks: referencesSection(session) },
    { id: "checks", heading: "Things to check", blocks: [{ kind: "list", items: textItems(plan?.reviewNotes ?? []) }] },
    {
      id: "answers",
      heading: "Interview answers",
      blocks: [
        {
          kind: "fields",
          fields: fields(session.answered.map((exchange) => [clean(exchange.question) || "Question", exchange.answer])),
        },
      ],
    },
  ];

  const sections = candidates
    .map((section) => ({ ...section, blocks: nonEmpty(section.blocks) }))
    .filter((section) => section.blocks.length > 0);

  return {
    title: clean(plan?.title) || clean(session.title) || "Untitled project",
    status,
    dateLabel,
    headerLabel: options.final ? `FINAL — ${dateLabel}` : "DRAFT",
    runtimeSeconds,
    runtimeLabel,
    hasPlan: plan !== null,
    notice: plan ? null : "There is no shot plan yet. This draft is built from the interview so far.",
    sections,
  };
}
