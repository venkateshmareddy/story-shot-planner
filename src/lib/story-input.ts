export type StoryMode = "idea" | "finished";

export const MAX_UPLOAD_MB = { txt: 5, pdf: 4 } as const;
export const BYTES_PER_MB = 1024 * 1024;
export const MAX_PDF_PAGES = 30;
export const MAX_STORY_CHARACTERS = 60_000;
export const MAX_ANSWER_CHARACTERS = 2_000;
export const MAX_FEEDBACK_CHARACTERS = 2_000;
export const MAX_VOICE_BYTES = 4_000_000;

export type StoryImportResult = { text: string } | { error: string };
