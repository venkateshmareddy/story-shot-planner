import { extractText, getDocumentProxy } from "unpdf";
import { readBody } from "@/lib/server/read-body";
import { checkSourceText } from "@/lib/source-text";
import { BYTES_PER_MB, MAX_PDF_PAGES, MAX_UPLOAD_MB } from "@/lib/story-input";

export const runtime = "nodejs";
export const maxDuration = 60;

const maxPdfBytes = MAX_UPLOAD_MB.pdf * BYTES_PER_MB;
const pdfSizeError = `Choose a PDF that is ${MAX_UPLOAD_MB.pdf} MB or smaller.`;
const interruptedError = "The upload was interrupted. Try again.";
const scannedError =
  "This PDF has no selectable text — it looks like scanned images. Paste the story, upload a TXT file, or use a PDF with selectable text.";

function reject(error: string, status: number) {
  return Response.json({ error }, { status });
}

function readFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return "This PDF is password-protected. Save an unlocked copy without a password and import that.";
  }
  if (name === "InvalidPDFException" || name === "FormatError") {
    return "This PDF is damaged or incomplete. Download or export it again and retry.";
  }
  return "This PDF couldn’t be read. Export it again as a standard PDF, or paste the story.";
}

/** Rejects instead of silently importing part of the story when most pages are images. */
function pageTextProblem(pages: string[]): string | null {
  const textless = pages.filter((page) => !/\S/.test(page)).length;
  if (textless === pages.length) return scannedError;
  if (textless * 2 > pages.length) {
    return `${textless} of this PDF’s ${pages.length} pages have no selectable text — they look like scanned images. Use a PDF with selectable text, or paste the story.`;
  }
  return null;
}

function mergePages(pages: string[]): string {
  return pages
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n");
}

export async function POST(request: Request) {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/pdf" || !request.body) return reject("Choose a PDF file to import.", 415);

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const body = await readBody(request, maxPdfBytes);
    if (!body) return reject(pdfSizeError, 413);
    if (!body.length) return reject("The PDF is empty.", 400);
    // pdf.js detaches the buffer it is given, so it must not share Node's pooled Buffer memory.
    bytes = Uint8Array.from(body);
  } catch {
    return reject(interruptedError, 400);
  }

  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
    return reject("This file doesn’t appear to be a PDF.", 422);
  }

  const { signal } = request;
  if (signal.aborted) return reject(interruptedError, 400);
  let pages: string[];
  let pageCount: number;
  try {
    const pdf = await getDocumentProxy(bytes);
    const stop = () => void pdf.loadingTask.destroy();
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) return reject(interruptedError, 400);
      pageCount = pdf.numPages;
      if (pageCount > MAX_PDF_PAGES) {
        return reject(
          `This PDF has ${pageCount} pages. The limit is ${MAX_PDF_PAGES} pages — split it and import one part at a time.`,
          422,
        );
      }
      pages = (await extractText(pdf, { mergePages: false })).text;
    } finally {
      signal.removeEventListener("abort", stop);
      await pdf.loadingTask.destroy();
    }
  } catch (error) {
    if (signal.aborted) return reject(interruptedError, 400);
    console.warn("PDF import failed", { reason: error instanceof Error ? error.name : "unknown" });
    return reject(readFailure(error), 422);
  }

  const pageProblem = pageTextProblem(pages);
  if (pageProblem) return reject(pageProblem, 422);

  const source = checkSourceText(mergePages(pages), "This PDF");
  if (!source.ok) return reject(source.error, 422);

  return Response.json({ text: source.text, pages: pageCount, characters: source.text.length });
}
