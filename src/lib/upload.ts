// Routing for files and long text entering the Studio. Pure and client-safe.
import { audioExtensionOf } from "./audio";
import type { StorySource } from "./source-text";

export type UploadKind = "image" | "document" | "audio";
export type UploadClass = UploadKind | { error: string };
export type DocumentExtension = "txt" | "pdf";

export const UNSUPPORTED_UPLOAD =
  "Choose a TXT or PDF story, an MP3, WAV, M4A or WebM audio file, or a PNG, JPG or WebP image.";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function extensionOf(name: string): string {
  return name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
}

export function imageTypeOf(file: { name: string; type: string }): string | null {
  const extension = extensionOf(file.name);
  if (Object.hasOwn(IMAGE_TYPES, extension)) return IMAGE_TYPES[extension];
  return Object.values(IMAGE_TYPES).includes(file.type) ? file.type : null;
}

export function documentExtensionOf(name: string): DocumentExtension | null {
  const extension = extensionOf(name);
  return extension === "txt" || extension === "pdf" ? extension : null;
}

export function classifyUpload(file: { name: string; type: string }): UploadClass {
  if (imageTypeOf(file)) return "image";
  if (documentExtensionOf(file.name)) return "document";
  if (audioExtensionOf(file.name)) return "audio";
  return { error: UNSUPPORTED_UPLOAD };
}

export type LongTextRoute = "source" | "composer" | "too-long-for-chat";

// "discovery" also covers a project without a plan. Text is never cut: it becomes the source or is refused.
export function routeLongText(input: {
  chars: number;
  origin: "document" | "transcript";
  phase: "discovery" | "refining";
  composerLimit: number;
}): LongTextRoute {
  const fits = input.chars <= input.composerLimit;
  if (input.phase === "refining") return fits ? "composer" : "too-long-for-chat";
  if (input.origin === "document") return "source";
  return fits ? "composer" : "source";
}

export function sourceNote(
  source: Pick<StorySource, "name" | "kind" | "characters" | "pages" | "digest">,
  options: { replaced?: string; digestFailed?: boolean } = {},
): string {
  const size = [
    `${source.characters.toLocaleString("en")} characters`,
    source.pages ? `${source.pages} page${source.pages === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const verb = source.kind === "audio" ? "transcribed" : "read";
  return [
    `I've ${verb} “${source.name}” (${size}).`,
    options.digestFailed
      ? "It's long and I couldn't make the condensed version I need for questions, so I can't use it until you import it again."
      : "I'll use the whole story and only ask about what's missing.",
    options.replaced && options.replaced !== source.name ? `It replaces “${options.replaced}” as the story source.` : "",
    source.digest ? "It's long, so I made a condensed version for questions; the full text is kept for the plan." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function tooLongForChatMessage(chars: number): string {
  return `This is longer than one chat message (${chars.toLocaleString("en")} characters). Start a new chat and import it there to build the plan from the whole story.`;
}
