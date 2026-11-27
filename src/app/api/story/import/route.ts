import { extractText, getDocumentProxy } from "unpdf";
import { BYTES_PER_MB, MAX_PDF_PAGES, MAX_STORY_CHARACTERS, MAX_UPLOAD_MB } from "@/lib/story-input";

export const runtime = "nodejs";

const maxPdfBytes = MAX_UPLOAD_MB.pdf * BYTES_PER_MB;
const pdfSizeError = `Choose a PDF that is ${MAX_UPLOAD_MB.pdf} MB or smaller.`;

function reject(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  if (request.headers.get("content-type") !== "application/pdf" || !request.body) {
    return reject("Choose a PDF file to import.", 415);
  }

  if (Number(request.headers.get("content-length")) > maxPdfBytes) {
    return reject(pdfSizeError, 413);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPdfBytes) {
        await reader.cancel().catch(() => {});
        return reject(pdfSizeError, 413);
      }
      chunks.push(value);
    }
  } catch {
    return reject("The upload was interrupted. Try again.", 400);
  } finally {
    reader.releaseLock();
  }

  const bytes = Uint8Array.from(Buffer.concat(chunks, size));

  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
    return reject("This file doesn’t appear to be a PDF.", 422);
  }

  try {
    const pdf = await getDocumentProxy(bytes);

    try {
      if (pdf.numPages > MAX_PDF_PAGES) {
        return reject(`Choose a PDF with at most ${MAX_PDF_PAGES} pages.`, 422);
      }

      const { text } = await extractText(pdf, { mergePages: true });
      if (!text.trim()) {
        return reject("This PDF has no selectable text. Paste the story or upload a TXT file.", 422);
      }

      if (text.length > MAX_STORY_CHARACTERS) {
        return reject("This story is too long. Import a shorter excerpt.", 422);
      }

      return Response.json({ text });
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch {
    return reject("This PDF couldn’t be read. Try an unlocked copy or paste the story.", 422);
  }
}
