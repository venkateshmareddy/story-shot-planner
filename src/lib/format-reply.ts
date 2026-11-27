export type ReplyBlock =
  | { type: "paragraph"; text: string }
  | { type: "label"; text: string }
  | { type: "list"; items: string[] };

export const MAX_LABEL_CHARACTERS = 40;

const BULLET = /^[-•*](?:\s+|$)(.*)$/;
const HEADING = /^#{1,6}(?:\s+|$)(.*)$/;

function stripBold(line: string): string {
  return line.replace(/\*\*(.+?)\*\*/g, "$1").replaceAll("**", "");
}

function isLabel(line: string): boolean {
  return line.length > 1 && line.length <= MAX_LABEL_CHARACTERS && line.endsWith(":");
}

/** Splits a plain-text reply into paragraphs, short "Label:" lines and bullet lists. Never returns markup. */
export function formatReply(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let listInterrupted = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  const closeList = () => {
    if (list.length > 0) blocks.push({ type: "list", items: list });
    list = [];
    listInterrupted = false;
  };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = stripBold(raw).trim();
    if (!line) {
      flushParagraph();
      if (list.length > 0) listInterrupted = true;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      const item = bullet[1].trim();
      if (item) list.push(item);
      listInterrupted = false;
      continue;
    }
    // An indented line straight after a bullet continues that bullet; a blank line or flush-left text ends the list.
    if (list.length > 0 && !listInterrupted && /^\s/.test(raw)) {
      list[list.length - 1] = `${list[list.length - 1]} ${line}`;
      continue;
    }
    closeList();
    const heading = HEADING.exec(line);
    if (heading || isLabel(line)) {
      flushParagraph();
      const label = heading ? heading[1].trim() : line;
      if (label) blocks.push({ type: "label", text: label });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return blocks;
}
