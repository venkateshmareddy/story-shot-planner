import type { StorySession } from "@/lib/session";

export const STOPPED_MESSAGE = "Stopped.";
export const STOPPED_DRAFT_MESSAGE = "Stopped. Your message is back in the box.";
export const STOPPED_IMPORT_MESSAGE = "Stopped. The story file wasn’t added.";
export const STOP_LABEL = "Stop the current request";

export type RequestOptions = { signal?: AbortSignal };

export type StoppedResult = { ok: false; error: string; stopped: true };

export function stoppedResult(): StoppedResult {
  return { ok: false, error: STOPPED_MESSAGE, stopped: true };
}

export function stoppedNotice(draftRestored: boolean): string {
  return draftRestored ? STOPPED_DRAFT_MESSAGE : STOPPED_MESSAGE;
}

export type TurnRollback = {
  messageId?: string;
  answered?: StorySession["answered"];
  pendingQuestion?: StorySession["pendingQuestion"];
};

/** Undoes an optimistic turn after a failed or stopped request; anything not named is left as it is. */
export function rollbackTurn(session: StorySession, { messageId, answered, pendingQuestion }: TurnRollback): StorySession {
  return {
    ...session,
    messages: messageId ? session.messages.filter((message) => message.id !== messageId) : session.messages,
    ...(answered ? { answered } : {}),
    ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
  };
}
