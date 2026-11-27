import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { MAX_PDF_FILE_BYTES, MAX_PDF_FILE_MB, readPdfText } from "../src/lib/pdf-text.ts";
import { MAX_SOURCE_CHARACTERS } from "../src/lib/source-text.ts";
import { BYTES_PER_MB, MAX_PDF_PAGES, MAX_UPLOAD_MB } from "../src/lib/story-input.ts";
import { importDocument } from "../src/lib/studio-agent.ts";

const LABEL = "“story.pdf”";

async function makePdf(pages: (string | null)[], size = 12): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([612, 792]);
    if (text) page.drawText(text, { x: 20, y: 770, size, lineHeight: size + 1, font });
  }
  return doc.save();
}

function encryptedPdf(): Uint8Array {
  const zeros = "0".repeat(64);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${zeros}> /U <${zeros}> /P -4 >>`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });

test("a text PDF gives the full normalised text and its page count", async () => {
  const pdf = await makePdf(["Mara finds the letter.\nShe reads it twice.", "The door closes.   Rain falls."]);
  const result = await readPdfText(blob(pdf), LABEL);
  assert.deepEqual(result, {
    ok: true,
    text: "Mara finds the letter.\nShe reads it twice.\nThe door closes. Rain falls.",
    pages: 2,
  });
});

test("a PDF over the page limit is refused before any text is read", async () => {
  const result = await readPdfText(blob(await makePdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => null))), LABEL);
  assert.deepEqual(result, {
    ok: false,
    error: `${LABEL} has ${MAX_PDF_PAGES + 1} pages. The limit is ${MAX_PDF_PAGES} pages — split it and import one part at a time.`,
  });
});

test("a PDF with no selectable text is explained as a likely scan", async () => {
  const blank = await readPdfText(blob(await makePdf([null, null])), LABEL);
  assert.equal(blank.ok, false);
  if (!blank.ok) {
    assert.match(blank.error, /^“story\.pdf” has no selectable text — it looks like a scanned PDF\./);
    assert.match(blank.error, /text file \(\.txt\) or paste it/);
  }
  const mostly = await readPdfText(blob(await makePdf(["Cover page", null, null])), LABEL);
  assert.equal(mostly.ok, false);
  if (!mostly.ok) assert.match(mostly.error, /^2 of the 3 pages in “story\.pdf” have no selectable text/);
});

test("an oversized PDF is refused without reading it", async () => {
  const huge = {
    size: MAX_PDF_FILE_BYTES + 1,
    arrayBuffer: () => Promise.reject(new Error("must not be read")),
  };
  assert.deepEqual(await readPdfText(huge, LABEL), {
    ok: false,
    error: `${LABEL} is larger than ${MAX_PDF_FILE_MB} MB. Split it and import one part at a time.`,
  });
  assert.equal((await readPdfText(blob(new Uint8Array()), LABEL)).ok, false);
});

test("corrupt, password-protected and non-PDF files get specific messages", async () => {
  const good = await makePdf(["Mara finds the letter."]);
  for (const damaged of [good.slice(0, Math.floor(good.length / 2)), new TextEncoder().encode("%PDF-1.7\nnot a real pdf")]) {
    const result = await readPdfText(blob(damaged), LABEL);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /^“story\.pdf” is damaged or incomplete\./);
  }
  const locked = await readPdfText(blob(encryptedPdf()), LABEL);
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.match(locked.error, /^“story\.pdf” is password-protected\./);
  const notPdf = await readPdfText(blob(new TextEncoder().encode("Just a story.")), LABEL);
  assert.deepEqual(notPdf, { ok: false, error: `${LABEL} doesn’t appear to be a PDF.` });
});

test("text over the source cap is refused, never cut", async () => {
  const line = "x".repeat(110);
  const page = Array.from({ length: 80 }, () => line).join("\n");
  const result = await readPdfText(blob(await makePdf(Array.from({ length: 36 }, () => page), 4)), LABEL);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /^“story\.pdf” is too long \([\d,]+ characters\)\. The limit is 300,000/);
  assert.ok(36 * 80 * 110 > MAX_SOURCE_CHARACTERS);
});

test("importDocument reads PDFs locally, past the old 4 MB upload limit, without calling the import route", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("no network");
  }) as typeof fetch;
  try {
    const doc = await PDFDocument.load(await makePdf(["Mara finds the letter.", "The door closes."]));
    const padding = new Uint8Array((MAX_UPLOAD_MB.pdf + 1) * BYTES_PER_MB);
    for (let offset = 0; offset < padding.length; offset += 65_536) crypto.getRandomValues(padding.subarray(offset, offset + 65_536));
    await doc.attach(padding, "padding.bin", { mimeType: "application/octet-stream" });
    const bytes = await doc.save();
    assert.ok(bytes.length > MAX_UPLOAD_MB.pdf * BYTES_PER_MB, "bigger than the old server upload limit");
    const result = await importDocument(new File([bytes as Uint8Array<ArrayBuffer>], "story.pdf", { type: "application/pdf" }));
    assert.deepEqual(result, { ok: true, text: "Mara finds the letter.\nThe door closes.", characters: 39, pages: 2 });
    const blank = await importDocument(new File([(await makePdf([null])) as Uint8Array<ArrayBuffer>], "scan.pdf"));
    assert.equal(blank.ok, false);
    if (!blank.ok) assert.match(blank.error, /^“scan\.pdf” has no selectable text/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
