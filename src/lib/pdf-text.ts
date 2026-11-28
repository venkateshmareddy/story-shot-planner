// Reads a PDF's text in the browser. pdf.js loads on demand, so it never enters the initial bundle.
import { checkSourceText, normalizeSourceText } from "./source-text";
import { BYTES_PER_MB, MAX_PDF_PAGES } from "./story-input";

export const MAX_PDF_FILE_MB = 50;
export const MAX_PDF_FILE_BYTES = MAX_PDF_FILE_MB * BYTES_PER_MB;

export type PdfText = { ok: true; text: string; pages: number } | { ok: false; error: string };

type PdfFile = Pick<Blob, "size" | "arrayBuffer">;

function readFailure(error: unknown, label: string): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return `${label} is password-protected. Save a copy without a password and import that.`;
  }
  if (name === "InvalidPDFException" || name === "FormatError") {
    return `${label} is damaged or incomplete. Download or export it again, then retry.`;
  }
  return `${label} couldn’t be read. Export it again as a standard PDF, or paste the story into the chat.`;
}

/** Rejects instead of importing part of a story when most pages are scanned images. */
function pageTextProblem(pages: string[], label: string): string | null {
  const textless = pages.filter((page) => !normalizeSourceText(page)).length;
  if (textless === pages.length) {
    return `${label} has no selectable text — it looks like a scanned PDF. Export the story as a text file (.txt) or paste it into the chat.`;
  }
  if (textless * 2 > pages.length) {
    return `${textless} of the ${pages.length} pages in ${label} have no selectable text — they look like scanned images. Export the story as a text file (.txt) or paste it into the chat.`;
  }
  return null;
}

function mergePages(pages: string[]): string {
  return pages
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n");
}

/**
 * Extracts the full text of a PDF, or explains in plain words why it can't. `label` names the file in messages.
 * An abort stops the parse; the caller checks the signal and ignores the result.
 */
export async function readPdfText(file: PdfFile, label: string, signal?: AbortSignal): Promise<PdfText> {
  if (file.size > MAX_PDF_FILE_BYTES) {
    return { ok: false, error: `${label} is larger than ${MAX_PDF_FILE_MB} MB. Split it and import one part at a time.` };
  }
  if (file.size === 0) return { ok: false, error: `${label} is empty.` };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, error: `${label} couldn’t be opened. Choose it again and retry.` };
  }
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
    return { ok: false, error: `${label} doesn’t appear to be a PDF.` };
  }

  const notRead: PdfText = { ok: false, error: `${label} wasn’t read.` };
  let pages: string[];
  let pageCount: number;
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    if (signal?.aborted) return notRead;
    const pdf = await getDocumentProxy(bytes);
    const stop = () => void pdf.loadingTask.destroy();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      if (signal?.aborted) return notRead;
      pageCount = pdf.numPages;
      if (pageCount > MAX_PDF_PAGES) {
        return {
          ok: false,
          error: `${label} has ${pageCount} pages. The limit is ${MAX_PDF_PAGES} pages — split it and import one part at a time.`,
        };
      }
      pages = (await extractText(pdf, { mergePages: false })).text;
    } finally {
      signal?.removeEventListener("abort", stop);
      await pdf.loadingTask.destroy();
    }
  } catch (error) {
    return { ok: false, error: readFailure(error, label) };
  }

  const problem = pageTextProblem(pages, label);
  if (problem) return { ok: false, error: problem };

  const checked = checkSourceText(mergePages(pages), label);
  if (!checked.ok) return checked;
  return { ok: true, text: checked.text, pages: pageCount };
}
