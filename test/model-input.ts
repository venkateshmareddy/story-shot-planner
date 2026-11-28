/** Reads a model input written by src/lib/server/memory-view.ts back into its "## TITLE" sections, in order. */
export function readSections(input: string): Map<string, string> {
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  let fence = "";
  for (const line of input.split("\n")) {
    const heading = !fence && /^## (.+)$/.exec(line);
    if (heading) {
      if (found.has(heading[1])) throw new Error(`Duplicate section ${heading[1]}`);
      current = [];
      found.set(heading[1], current);
      continue;
    }
    if (!current) throw new Error(`Text before the first section: ${line}`);
    const marker = /^(`{3,})$/.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) fence = fence ? "" : marker;
    current.push(line);
  }
  if (fence) throw new Error("Unclosed fence");
  return new Map([...found].map(([title, lines]) => [title, lines.join("\n")]));
}

export function sectionText(input: string, title: string): string | undefined {
  const body = readSections(input).get(title);
  if (body === undefined) return undefined;
  const fenced = /^(`{3,})\n([\s\S]*)\n\1$/.exec(body);
  return fenced ? fenced[2] : body;
}

export function sectionJson<T = unknown>(input: string, title: string): T | undefined {
  const text = sectionText(input, title);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

/** "- item" lines of a list section; [] when the section is absent. */
export function sectionList(input: string, title: string): string[] {
  return (sectionText(input, title) ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

export const sectionTitles = (input: string) => [...readSections(input).keys()];

export type ReadFact = { category: string; label: string; value: string; status: "filmmaker" | "approved" | "ai_suggestion" };

const GROUP_STATUS: Record<string, ReadFact["status"]> = {
  "From the filmmaker:": "filmmaker",
  "Approved:": "approved",
  "AI suggestions:": "ai_suggestion",
};

/** The "MEMORY — what we know" facts, each with the group it was listed under. */
export function memoryFacts(input: string): ReadFact[] {
  let status: ReadFact["status"] | undefined;
  const facts: ReadFact[] = [];
  for (const line of (sectionText(input, "MEMORY — what we know") ?? "").split("\n").filter(Boolean)) {
    if (line in GROUP_STATUS) {
      status = GROUP_STATUS[line];
      continue;
    }
    const match = /^- ([a-z]+) · (.+?): (.*)$/.exec(line);
    if (!match || !status) throw new Error(`Unexpected memory line: ${line}`);
    facts.push({ category: match[1], label: match[2], value: match[3], status });
  }
  return facts;
}

export type ReadDecision = { status: "accepted" | "rejected"; request: string; changes: string[] };

export function decisionsOf(input: string): ReadDecision[] {
  return sectionList(input, "DECISIONS").map((line) => {
    const match = /^(Applied|Discarded): (.*?)(?: → (.*))?$/.exec(line);
    if (!match) throw new Error(`Unexpected decision line: ${line}`);
    return { status: match[1] === "Applied" ? "accepted" : "rejected", request: match[2], changes: match[3] ? match[3].split("; ") : [] };
  });
}
