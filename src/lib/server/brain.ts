import { readFileSync } from "node:fs";
import path from "node:path";

/** The Creative Director's static brain: Markdown files shipped with the server (next.config outputFileTracingIncludes). */
export const BRAIN_DIR = path.join(process.cwd(), "src", "agents", "creative-director");

export type BrainVars = Readonly<Record<string, string | number>>;
export type BrainSections = Readonly<Record<string, string>>;

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
const SECTION_HEADING = /^## +(.+?)[ \t]*$/gm;

/** Drops <!-- editor notes --> and the top "# Title" line: they are for humans and cost the model nothing. */
export function stripEditorNotes(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*# [^\n]*\n/, "");
}

/** Fills {{NAME}} placeholders and tidies lines. Blank lines between paragraphs become one line break. */
function fill(body: string, vars: BrainVars, source: string): string {
  const text = body
    .replace(PLACEHOLDER, (_match, name: string) => {
      if (!Object.hasOwn(vars, name)) throw new Error(`${source}: no value for {{${name}}}`);
      return String(vars[name]);
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!text) throw new Error(`${source} is empty`);
  return text;
}

/**
 * Turns a brain file into prompt text: drops editor notes and the title, fills {{NAME}} placeholders from `vars`, and
 * tidies lines. Throws on a missing placeholder value, so a typo in a .md file fails at startup and in tests instead of
 * reaching the model.
 */
export function renderBrainText(markdown: string, vars: BrainVars = {}, source = "brain file"): string {
  return fill(stripEditorNotes(markdown), vars, source);
}

/** Raw "## name" blocks of a brain file, in file order, notes and title removed. Every line must sit in a section. */
export function splitBrainSections(markdown: string, source = "brain file"): Record<string, string> {
  const body = stripEditorNotes(markdown);
  const headings = [...body.matchAll(SECTION_HEADING)];
  if (!headings.length) throw new Error(`${source} has no ## sections`);
  if (body.slice(0, headings[0].index).trim()) throw new Error(`${source}: text before the first ## section`);
  const sections: Record<string, string> = {};
  headings.forEach((heading, index) => {
    const name = heading[1];
    if (Object.hasOwn(sections, name)) throw new Error(`${source}: duplicate section "${name}"`);
    sections[name] = body.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? body.length);
  });
  return sections;
}

/** One brain file, read once; render it as many times as needed with different values. */
export type BrainDoc = {
  text: (vars?: BrainVars) => string;
  sections: (vars?: BrainVars) => BrainSections;
};

function brainPath(relativePath: string): string {
  const file = path.join(BRAIN_DIR, relativePath);
  if (!file.startsWith(BRAIN_DIR + path.sep) || path.extname(file) !== ".md") {
    throw new Error(`Not a brain file: ${relativePath}`);
  }
  return file;
}

/** Reads a brain file relative to BRAIN_DIR. Call at module load only. */
export function loadBrain(relativePath: string): BrainDoc {
  const markdown = readFileSync(brainPath(relativePath), "utf8");
  return {
    text: (vars = {}) => renderBrainText(markdown, vars, relativePath),
    sections: (vars = {}) =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(splitBrainSections(markdown, relativePath)).map(([name, body]) => [name, fill(body, vars, `${relativePath}#${name}`)]),
        ),
      ),
  };
}

/** One brain file as prompt text. Call at module load only; the result is an immutable string. */
export function brainFile(relativePath: string, vars: BrainVars = {}): string {
  return loadBrain(relativePath).text(vars);
}

/** A brain file made of "## name" blocks, each rendered as prompt text. Call at module load only. */
export function brainSections(relativePath: string, vars: BrainVars = {}): BrainSections {
  return loadBrain(relativePath).sections(vars);
}
