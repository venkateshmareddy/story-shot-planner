import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { Blueprint, BlueprintBlock, BlueprintScene, BlueprintShot } from "@/lib/blueprint";

const ACCENT = "893A26";
const MUTED = "62594E";
const INK = "231D17";
const HEADER_FILL = "F5F2EB";
const A4 = { width: 11906, height: 16838 };
const MARGIN = 1134;
const SHOT_COLUMNS = [1250, 1650, 2900, 1900, 1938];

/** Word XML rejects control characters and unpaired surrogates. */
function xmlSafe(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000
    ) {
      out += char;
    }
  }
  return out;
}

function run(text: string, options: { bold?: boolean; color?: string; size?: number } = {}): TextRun {
  return new TextRun({ text: xmlSafe(text), ...options });
}

function labelled(label: string, value: string, size?: number): Paragraph {
  return new Paragraph({
    spacing: { after: 60 },
    children: [run(`${label}: `, { bold: true, size }), run(value, { size })],
  });
}

function shotCell(paragraphs: Paragraph[], header = false): TableCell {
  return new TableCell({
    children: paragraphs.length > 0 ? paragraphs : [new Paragraph("")],
    shading: header ? { type: ShadingType.CLEAR, fill: HEADER_FILL, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

function small(text: string, bold = false): Paragraph {
  return new Paragraph({ children: [run(text, { bold, size: 18 })] });
}

function shotRow(shot: BlueprintShot): TableRow {
  const field = (label: string, value: string) => (value ? [labelled(label, value, 18)] : []);
  return new TableRow({
    cantSplit: true,
    children: [
      shotCell([small(shot.id, true), small(shot.length)]),
      shotCell([...(shot.framing ? [small(shot.framing)] : []), ...(shot.camera ? [small(shot.camera)] : [])]),
      shotCell([...(shot.action ? [small(shot.action)] : []), ...field("Who", shot.who), ...field("Place", shot.place)]),
      shotCell([...field("Feeling", shot.feeling), ...field("Sound", shot.sound)]),
      shotCell(shot.dialogue.map((line) => small(line))),
    ],
  });
}

function sceneTable(scene: BlueprintScene): (Paragraph | Table)[] {
  const header = new TableRow({
    tableHeader: true,
    children: ["Shot", "Shot size and camera", "What happens", "Feeling and sound", "Dialogue"].map((label) =>
      shotCell([small(label, true)], true),
    ),
  });
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_3,
      keepNext: true,
      children: [run(`${scene.id} · ${scene.title} · ${scene.length}`)],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: SHOT_COLUMNS,
      rows: [header, ...scene.shots.map(shotRow)],
    }),
    new Paragraph(""),
  ];
}

function blockToDocx(block: BlueprintBlock): (Paragraph | Table)[] {
  switch (block.kind) {
    case "paragraph":
      return [new Paragraph({ spacing: { after: 120 }, children: [run(block.text)] })];
    case "subheading":
      return [new Paragraph({ heading: HeadingLevel.HEADING_3, keepNext: true, children: [run(block.text)] })];
    case "fields":
      return block.fields.map((field) => labelled(field.label, field.value));
    case "list":
      return block.items.map(
        (item) =>
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            children: item.lead ? [run(`${item.lead}: `, { bold: true }), run(item.text)] : [run(item.text)],
          }),
      );
    case "scene":
      return sceneTable(block.scene);
  }
}

export function blueprintToDocx(bp: Blueprint): Document {
  const statusLine = [
    bp.status === "Final" ? `Final blueprint, ${bp.dateLabel}` : `Draft blueprint, prepared ${bp.dateLabel}`,
    bp.runtimeSeconds > 0 ? `Runtime about ${bp.runtimeLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [run(bp.title)] }),
    new Paragraph({ spacing: { after: 200 }, children: [run(statusLine, { color: MUTED })] }),
    ...(bp.notice ? [new Paragraph({ spacing: { after: 200 }, children: [run(bp.notice, { color: ACCENT })] })] : []),
  ];
  for (const section of bp.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, children: [run(section.heading)] }));
    for (const block of section.blocks) children.push(...blockToDocx(block));
  }

  return new Document({
    title: xmlSafe(bp.title),
    subject: `${bp.status} filmmaking blueprint`,
    creator: "AI Creative Studio",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 21, color: INK } },
        title: { run: { font: "Calibri", size: 44, bold: true, color: INK } },
        heading1: {
          run: { font: "Calibri", size: 28, bold: true, color: ACCENT },
          paragraph: { spacing: { before: 360, after: 120 } },
        },
        heading3: {
          run: { font: "Calibri", size: 23, bold: true, color: INK },
          paragraph: { spacing: { before: 200, after: 80 } },
        },
      },
    },
    sections: [
      {
        properties: { page: { size: A4, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [run(bp.headerLabel, { bold: true, color: ACCENT, size: 16 }), run(`   ${bp.title}`, { color: MUTED, size: 16 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, color: MUTED })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}

export function toDocxBlob(doc: Document): Promise<Blob> {
  return Packer.toBlob(doc);
}
