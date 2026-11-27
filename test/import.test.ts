import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { POST } from "../src/app/api/story/import/route.ts";
import { MAX_SOURCE_CHARACTERS } from "../src/lib/source-text.ts";
import { BYTES_PER_MB, MAX_PDF_PAGES, MAX_UPLOAD_MB } from "../src/lib/story-input.ts";

async function makePdf(pages: (string | null)[], size = 12): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([612, 792]);
    if (text) page.drawText(text, { x: 20, y: 770, size, lineHeight: size + 1, font });
  }
  return doc.save();
}

function rawPdf(objects: string[], trailer: string): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function encryptedPdf(): Uint8Array {
  const zeros = "0".repeat(64);
  return rawPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      `<< /Filter /Standard /V 1 /R 2 /O <${zeros}> /U <${zeros}> /P -4 >>`,
    ],
    "/Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]",
  );
}

function upload(body: Uint8Array | null, type: string | null = "application/pdf", length?: number) {
  const headers = new Headers();
  if (type) headers.set("content-type", type);
  if (length !== undefined) headers.set("content-length", String(length));
  return new Request("http://localhost/api/story/import", { method: "POST", headers, body });
}

async function importPdf(bytes: Uint8Array) {
  const response = await POST(upload(bytes));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("a text PDF returns the full normalised text, page count and character count", async () => {
  const pdf = await makePdf(["Mara finds the letter.\nShe reads it twice.", null, "The door closes.   Rain falls."]);
  const { status, body } = await importPdf(pdf);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["characters", "pages", "text"]);
  assert.equal(body.pages, 3);
  assert.equal(body.text, "Mara finds the letter.\nShe reads it twice.\n\nThe door closes. Rain falls.");
  assert.equal(body.characters, (body.text as string).length);
});

test("long PDFs beyond the old 60,000-character limit import in full", async () => {
  const line = "The courier crosses the bridge at dawn and counts the lanterns again.";
  const page = Array.from({ length: 50 }, () => line).join("\n");
  const { status, body } = await importPdf(await makePdf(Array.from({ length: 20 }, () => page), 6));
  assert.equal(status, 200);
  assert.equal(body.pages, 20);
  assert.ok((body.characters as number) > 60_000);
  assert.equal((body.text as string).split(line).length - 1, 1_000);
});

test("text over the 300,000-character cap is rejected, never cut", async () => {
  const line = "x".repeat(110);
  const page = Array.from({ length: 80 }, () => line).join("\n");
  const { status, body } = await importPdf(await makePdf(Array.from({ length: 36 }, () => page), 4));
  assert.equal(status, 422);
  assert.match(body.error as string, /^This PDF is too long \([\d,]+ characters\)\. The limit is 300,000/);
  assert.equal(body.text, undefined);
  assert.ok(36 * 80 * 110 > MAX_SOURCE_CHARACTERS);
});

test("scanned PDFs with no or mostly no selectable text are rejected", async () => {
  const blank = await importPdf(await makePdf([null, null, null]));
  assert.equal(blank.status, 422);
  assert.match(blank.body.error as string, /no selectable text — it looks like scanned images/);

  const mostly = await importPdf(await makePdf(["Cover page: The Letter", null, null, null]));
  assert.equal(mostly.status, 422);
  assert.match(mostly.body.error as string, /^3 of this PDF’s 4 pages have no selectable text/);
  assert.equal(mostly.body.text, undefined);
});

test("password-protected, damaged and over-long PDFs get specific messages", async () => {
  const locked = await importPdf(encryptedPdf());
  assert.equal(locked.status, 422);
  assert.match(locked.body.error as string, /password-protected/);

  const good = await makePdf(["Mara finds the letter."]);
  for (const damaged of [good.slice(0, Math.floor(good.length / 2)), new TextEncoder().encode("%PDF-1.7\nnot a real pdf")]) {
    const result = await importPdf(damaged);
    assert.equal(result.status, 422);
    assert.match(result.body.error as string, /damaged or incomplete/);
  }

  const tooMany = await importPdf(await makePdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => null)));
  assert.equal(tooMany.status, 422);
  assert.equal(
    tooMany.body.error,
    `This PDF has ${MAX_PDF_PAGES + 1} pages. The limit is ${MAX_PDF_PAGES} pages — split it and import one part at a time.`,
  );
});

test("upload type, size and signature checks run before parsing", async () => {
  const pdf = await makePdf(["Hello."]);
  assert.equal((await POST(upload(pdf, "text/plain"))).status, 415);
  assert.equal((await POST(upload(pdf, null))).status, 415);
  assert.equal((await POST(upload(null))).status, 415);
  assert.equal((await POST(upload(pdf, "application/pdf; charset=binary"))).status, 200);

  const maxBytes = MAX_UPLOAD_MB.pdf * BYTES_PER_MB;
  assert.equal((await POST(upload(pdf, "application/pdf", maxBytes + 1))).status, 413);
  assert.equal((await POST(upload(new Uint8Array(maxBytes + 1)))).status, 413);
  assert.equal((await POST(upload(new Uint8Array()))).status, 400);

  const notPdf = await importPdf(new TextEncoder().encode("Just a story in a text file."));
  assert.equal(notPdf.status, 422);
  assert.match(notPdf.body.error as string, /doesn’t appear to be a PDF/);
});
