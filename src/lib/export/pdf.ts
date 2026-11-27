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
/** One table cell: a stack of paragraphs; a muted paragraph renders as the grey sub-line. */
type TableCell = { runs: Run[]; muted?: boolean }[];

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

  private wrapRuns(runs: Run[], size: number, maxWidth: number): Token[][] {
    return this.wrap(this.tokenize(runs), size, Math.max(8, maxWidth));
  }

  /** Draws a stack of paragraphs starting at topY within a fixed width; returns the height used. */
  private drawParagraphs(cell: TableCell, x: number, topY: number, width: number, size: number, leading: number): number {
    let y = topY;
    for (const para of cell) {
      const color = para.muted ? MUTED : INK;
      for (const line of this.wrapRuns(para.runs, size, width)) {
        y -= leading;
        const baseline = y + (leading - size) * 0.5;
        let cx = x;
        let chunk = "";
        let chunkFont = line[0]?.font ?? this.regular;
        const flush = () => {
          if (!chunk) return;
          this.page.drawText(chunk, { x: cx, y: baseline, size, font: chunkFont, color });
          cx += chunkFont.widthOfTextAtSize(chunk, size);
          chunk = "";
        };
        line.forEach((token, index) => {
          const prefix = index > 0 && token.spaceBefore ? " " : "";
          if (token.font !== chunkFont) {
            flush();
            chunkFont = token.font;
          }
          chunk += prefix + token.text;
        });
        flush();
      }
    }
    return topY - y;
  }

  private measureCell(cell: TableCell, width: number, size: number): number {
    return cell.reduce((lines, para) => lines + this.wrapRuns(para.runs, size, width).length, 0);
  }

  table(headers: string[], widths: number[], rows: TableCell[][]) {
    const size = 7;
    const leading = size * 1.3;
    const padX = 3;
    const padY = 4;
    const xs: number[] = [];
    let cursor = MARGIN_X;
    for (const width of widths) {
      xs.push(cursor);
      cursor += width;
    }
    const drawHeader = () => {
      this.ensure(leading + padY);
      const rowTop = this.y;
      headers.forEach((header, index) => {
        this.drawParagraphs([{ runs: [{ text: header, bold: true }], muted: true }], xs[index] + padX, rowTop, widths[index] - padX * 2, size, leading);
      });
      this.y = rowTop - (leading + padY);
      this.rule(RULE);
    };
    drawHeader();
    for (const row of rows) {
      const maxLines = Math.max(1, ...row.map((cell, index) => this.measureCell(cell, widths[index] - padX * 2, size)));
      const rowHeight = maxLines * leading + padY * 2;
      if (this.y - rowHeight < MARGIN_BOTTOM) {
        this.newPage();
        drawHeader();
      }
      const rowTop = this.y;
      row.forEach((cell, index) => {
        this.drawParagraphs(cell, xs[index] + padX, rowTop - padY, widths[index] - padX * 2, size, leading);
      });
      this.y = rowTop - rowHeight;
      this.rule(RULE);
    }
    this.space(6);
  }
}

const SHOT_HEADERS = ["Shot", "Sec", "Framing / Camera", "Who / Location", "What we see", "Dialogue", "Emotion", "Sound"];
const SHOT_WIDTHS = [54, 22, 80, 66, 92, 66, 50, 53];

function writeScene(writer: PdfWriter, scene: BlueprintScene) {
  writer.heading(`${scene.id} · ${scene.title} · ${scene.length}`, 12, INK, 14, 54);
  const places = [...new Set(scene.shots.map((shot) => shot.place).filter(Boolean))].join(" · ");
  if (places) {
    writer.text([{ text: places }], { size: 9, color: MUTED });
    writer.space(2);
  }
  if (scene.shots.length === 0) {
    writer.text([{ text: "No shots yet." }], { size: 9.5, color: MUTED });
    return;
  }
  const rows: TableCell[][] = scene.shots.map((shot) => [
    [{ runs: [{ text: shot.id, bold: true }] }],
    [{ runs: [{ text: shot.length }] }],
    [{ runs: [{ text: shot.framing || "—" }] }, ...(shot.camera ? [{ runs: [{ text: shot.camera }], muted: true }] : [])],
    [{ runs: [{ text: shot.who || "None" }] }, ...(shot.place ? [{ runs: [{ text: shot.place }], muted: true }] : [])],
    [{ runs: [{ text: shot.action || "—" }] }],
    shot.dialogue.length > 0
      ? shot.dialogue.map((line) => ({ runs: [{ text: line }] }))
      : [{ runs: [{ text: "—" }], muted: true }],
    [{ runs: [{ text: shot.feeling || "—" }] }],
    [{ runs: [{ text: shot.sound || "—" }] }],
  ]);
  writer.table(SHOT_HEADERS, SHOT_WIDTHS, rows);
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
