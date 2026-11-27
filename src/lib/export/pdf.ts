import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { Blueprint, BlueprintBlock, BlueprintScene } from "@/lib/blueprint";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 64;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const INK = rgb(0.137, 0.114, 0.09);
const MUTED = rgb(0.384, 0.349, 0.306);
const ACCENT = rgb(0.537, 0.227, 0.149);
const RULE = rgb(0.847, 0.812, 0.761);

const REPLACEMENTS: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "⇒": "=>",
  "⇐": "<=",
  "⟶": "->",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "≈": "~",
  "−": "-",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "―": "—",
  "′": "'",
  "″": '"',
  "✓": "v",
  "✔": "v",
  "✗": "x",
  "✘": "x",
  "★": "*",
  "☆": "*",
};

function isDroppable(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    codePoint >= 0x1f000
  );
}

/** Standard PDF fonts only encode WinAnsi; map or drop everything else so drawing never throws. */
export function toWinAnsi(text: string, supported: ReadonlySet<number>): string {
  let out = "";
  for (const char of text.replace(/\s+/g, " ")) {
    const mapped = REPLACEMENTS[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const codePoint = char.codePointAt(0) ?? 0;
    if (supported.has(codePoint)) {
      out += char;
      continue;
    }
    const decomposed = [...char.normalize("NFKD")].filter((part) => supported.has(part.codePointAt(0) ?? 0)).join("");
    if (decomposed) out += decomposed;
    else if (!isDroppable(codePoint)) out += "?";
  }
  return out.replace(/ {2,}/g, " ");
}

type Run = { text: string; bold?: boolean };
type Token = { text: string; font: PDFFont; spaceBefore: boolean };
type TextStyle = { size: number; indent?: number; color?: ReturnType<typeof rgb>; leading?: number; bullet?: boolean };

class PdfWriter {
  readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  private readonly supported: ReadonlySet<number>;

  constructor(
    private readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    const boldSet = new Set(bold.getCharacterSet());
    this.supported = new Set(regular.getCharacterSet().filter((code) => boldSet.has(code)));
    this.newPage();
  }

  safe(text: string): string {
    return toWinAnsi(text, this.supported);
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN_BOTTOM) this.newPage();
  }

  space(amount: number) {
    this.y -= amount;
  }

  rule(color = RULE) {
    this.page.drawLine({
      start: { x: MARGIN_X, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN_X, y: this.y },
      thickness: 0.6,
      color,
    });
  }

  private tokenize(runs: Run[]): Token[] {
    const tokens: Token[] = [];
    let pendingSpace = false;
    for (const run of runs) {
      const font = run.bold ? this.bold : this.regular;
      const text = this.safe(run.text);
      const parts = text.split(" ");
      parts.forEach((part, index) => {
        if (index > 0) pendingSpace = true;
        if (!part) return;
        tokens.push({ text: part, font, spaceBefore: pendingSpace && tokens.length > 0 });
        pendingSpace = false;
      });
    }
    return tokens;
  }

  private splitLong(token: Token, size: number, maxWidth: number): Token[] {
    const pieces: Token[] = [];
    let current = "";
    for (const char of token.text) {
      if (current && token.font.widthOfTextAtSize(current + char, size) > maxWidth) {
        pieces.push({ text: current, font: token.font, spaceBefore: pieces.length === 0 && token.spaceBefore });
        current = "";
      }
      current += char;
    }
    if (current) pieces.push({ text: current, font: token.font, spaceBefore: pieces.length === 0 && token.spaceBefore });
    return pieces;
  }

  private wrap(tokens: Token[], size: number, maxWidth: number): Token[][] {
    const lines: Token[][] = [];
    let line: Token[] = [];
    let width = 0;
    const queue = [...tokens];
    while (queue.length > 0) {
      const token = queue.shift() as Token;
      const wordWidth = token.font.widthOfTextAtSize(token.text, size);
      const gap = line.length > 0 && token.spaceBefore ? token.font.widthOfTextAtSize(" ", size) : 0;
      if (line.length > 0 && width + gap + wordWidth > maxWidth) {
        lines.push(line);
        line = [];
        width = 0;
        queue.unshift(token);
        continue;
      }
      if (line.length === 0 && wordWidth > maxWidth) {
        queue.unshift(...this.splitLong(token, size, maxWidth));
        const first = queue.shift() as Token;
        line.push(first);
        width = first.font.widthOfTextAtSize(first.text, size);
        continue;
      }
      line.push(token);
      width += gap + wordWidth;
    }
    if (line.length > 0) lines.push(line);
    return lines;
  }

  text(runs: Run[], style: TextStyle) {
    const indent = style.indent ?? 0;
    const bulletIndent = style.bullet ? 12 : 0;
    const leading = style.leading ?? style.size * 1.4;
    const maxWidth = CONTENT_WIDTH - indent - bulletIndent;
    const lines = this.wrap(this.tokenize(runs), style.size, maxWidth);
    lines.forEach((line, lineIndex) => {
      this.ensure(leading);
      this.y -= leading;
      const baseline = this.y + (leading - style.size) * 0.5;
      if (style.bullet && lineIndex === 0) {
        this.page.drawText("•", { x: MARGIN_X + indent, y: baseline, size: style.size, font: this.regular, color: ACCENT });
      }
      let x = MARGIN_X + indent + bulletIndent;
      let chunk = "";
      let chunkFont = line[0]?.font ?? this.regular;
      const flush = () => {
        if (!chunk) return;
        this.page.drawText(chunk, { x, y: baseline, size: style.size, font: chunkFont, color: style.color ?? INK });
        x += chunkFont.widthOfTextAtSize(chunk, style.size);
        chunk = "";
      };
      line.forEach((token, tokenIndex) => {
        const prefix = tokenIndex > 0 && token.spaceBefore ? " " : "";
        if (token.font !== chunkFont) {
          flush();
          chunkFont = token.font;
        }
        chunk += prefix + token.text;
      });
      flush();
    });
  }

  heading(text: string, size: number, color: ReturnType<typeof rgb>, before: number, keepWithNext: number) {
    this.ensure(before + size * 1.4 + keepWithNext);
    if (this.y < PAGE_HEIGHT - MARGIN_TOP) this.space(before);
    this.text([{ text, bold: true }], { size, color });
  }
}

function writeScene(writer: PdfWriter, scene: BlueprintScene) {
  writer.heading(`${scene.id} · ${scene.title} · ${scene.length}`, 12, INK, 14, 40);
  for (const shot of scene.shots) {
    const header = [shot.id, shot.length, shot.framing, shot.camera].filter(Boolean).join(" · ");
    writer.ensure(48);
    writer.space(6);
    writer.text([{ text: header, bold: true }], { size: 10, color: ACCENT });
    const details: [string, string][] = [
      ["What happens", shot.action],
      ["Who", shot.who],
      ["Place", shot.place],
      ["Feeling", shot.feeling],
      ["Sound", shot.sound],
    ];
    for (const [label, value] of details) {
      if (value) writer.text([{ text: `${label}: `, bold: true }, { text: value }], { size: 9.5, indent: 12 });
    }
    if (shot.dialogue.length > 0) {
      writer.text([{ text: "Dialogue:", bold: true }], { size: 9.5, indent: 12 });
      for (const line of shot.dialogue) writer.text([{ text: line }], { size: 9.5, indent: 24 });
    }
  }
}

function writeBlock(writer: PdfWriter, block: BlueprintBlock) {
  switch (block.kind) {
    case "paragraph":
      writer.text([{ text: block.text }], { size: 10 });
      writer.space(4);
      return;
    case "subheading":
      writer.heading(block.text, 11, INK, 8, 28);
      return;
    case "fields":
      for (const field of block.fields) {
        writer.text([{ text: `${field.label}: `, bold: true }, { text: field.value }], { size: 10 });
        writer.space(3);
      }
      return;
    case "list":
      for (const item of block.items) {
        const runs: Run[] = item.lead ? [{ text: `${item.lead}: `, bold: true }, { text: item.text }] : [{ text: item.text }];
        writer.text(runs, { size: 10, bullet: true });
        writer.space(3);
      }
      return;
    case "scene":
      writeScene(writer, block.scene);
      return;
  }
}

function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 0 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export async function blueprintToPdf(bp: Blueprint): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const writer = new PdfWriter(doc, regular, bold);
  const title = writer.safe(bp.title).trim() || "Untitled project";

  doc.setTitle(title);
  doc.setSubject(`${bp.status} filmmaking blueprint`);
  doc.setCreator("AI Creative Studio");

  writer.text([{ text: title, bold: true }], { size: 22, leading: 28 });
  const statusLine = [
    bp.status === "Final" ? `Final blueprint, ${bp.dateLabel}` : `Draft blueprint, prepared ${bp.dateLabel}`,
    bp.runtimeSeconds > 0 ? `Runtime about ${bp.runtimeLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  writer.text([{ text: statusLine }], { size: 10, color: MUTED });
  if (bp.notice) {
    writer.space(6);
    writer.text([{ text: bp.notice }], { size: 10, color: ACCENT });
  }

  for (const section of bp.sections) {
    writer.heading(section.heading, 14, ACCENT, 20, 36);
    writer.space(2);
    writer.rule();
    writer.space(4);
    for (const block of section.blocks) writeBlock(writer, block);
  }

  const header = writer.safe(bp.headerLabel);
  const shortTitle = fitText(title, regular, 8, CONTENT_WIDTH / 2);
  const total = writer.pages.length;
  writer.pages.forEach((page, index) => {
    const top = PAGE_HEIGHT - 40;
    page.drawText(header, { x: MARGIN_X, y: top, size: 8, font: bold, color: ACCENT });
    page.drawText(shortTitle, {
      x: PAGE_WIDTH - MARGIN_X - regular.widthOfTextAtSize(shortTitle, 8),
      y: top,
      size: 8,
      font: regular,
      color: MUTED,
    });
    page.drawLine({ start: { x: MARGIN_X, y: top - 6 }, end: { x: PAGE_WIDTH - MARGIN_X, y: top - 6 }, thickness: 0.5, color: RULE });
    const footer = `Page ${index + 1} of ${total}`;
    page.drawText(footer, {
      x: (PAGE_WIDTH - regular.widthOfTextAtSize(footer, 8)) / 2,
      y: 32,
      size: 8,
      font: regular,
      color: MUTED,
    });
  });

  return doc.save();
}
