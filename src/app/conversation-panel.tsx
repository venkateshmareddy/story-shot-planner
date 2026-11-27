"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { VoiceRecorder } from "./voice-recorder";
import { type ImageReference, type Recommendation, SPECIALIST_LABELS, type SpecialistId } from "@/lib/agents/types";
import { AUDIO_ACCEPT } from "@/lib/audio";
import { formatReply } from "@/lib/format-reply";
import { proposalConfirmation } from "@/lib/proposal-copy";
import { DISCOVERY_ACTIONS, QUICK_ACTIONS } from "@/lib/quick-actions";
import { MAX_ANSWER_CHARACTERS, MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/story-input";
import type { ChatMessage, StorySession } from "@/lib/session";

const PRIORITY_LABELS: Record<Recommendation["priority"], string> = { high: "High", medium: "Medium", low: "Low" };
const OPEN_NOTES_LIMIT = 3;
const ATTACH_ACCEPT = `.txt,.pdf,.png,.jpg,.jpeg,.webp,${AUDIO_ACCEPT},text/plain,application/pdf,image/png,image/jpeg,image/webp`;
const ATTACH_LABEL =
  "Attach a story (.txt, .pdf), an audio file (.mp3, .wav, .m4a, .webm) or a reference image (.png, .jpg, .webp)";
const UPLOADING_LABELS = {
  document: "Reading document…",
  image: "Studying your image…",
  audio: "Transcribing your audio file…",
} as const;

export type UploadingKind = keyof typeof UPLOADING_LABELS;

function specialistLabel(id: SpecialistId): string {
  return SPECIALIST_LABELS[id] ?? id;
}

function groupBySpecialist(recommendations: Recommendation[]): [SpecialistId, Recommendation[]][] {
  const groups = new Map<SpecialistId, Recommendation[]>();
  for (const item of recommendations) groups.set(item.specialist, [...(groups.get(item.specialist) ?? []), item]);
  return [...groups.entries()];
}

function TeamNotes({ message }: { message: ChatMessage }) {
  const recommendations = message.recommendations ?? [];
  const conflicts = message.conflicts ?? [];
  const failed = message.failedSpecialists ?? [];
  if (recommendations.length === 0 && conflicts.length === 0 && failed.length === 0) return null;
  return (
    <div className="chat-team">
      {recommendations.length > 0 && (
        <details className="chat-team-details" open={recommendations.length <= OPEN_NOTES_LIMIT}>
          <summary>Expert suggestions ({recommendations.length})</summary>
          {groupBySpecialist(recommendations).map(([specialist, items]) => (
            <div className="chat-rec-group" key={specialist}>
              <p className="chat-team-head">{specialistLabel(specialist)}</p>
              <ul className="chat-rec-list">
                {items.map((item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Recommendations are fixed per reply and may repeat.
                  <li className="chat-rec" key={index}>
                    <div className="chat-rec-meta">
                      <span className="chat-rec-target">{item.target}</span>
                      <span className={`chat-rec-priority chat-rec-priority-${item.priority}`}>
                        {PRIORITY_LABELS[item.priority] ?? item.priority}
                        <span className="sr-only"> priority</span>
                      </span>
                    </div>
                    <p>{item.recommendation}</p>
                    {item.rationale && <p className="muted chat-rec-why">{item.rationale}</p>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
      {conflicts.length > 0 && (
        <div className="chat-team-conflicts">
          <p className="chat-team-head">Where the advice differs</p>
          <ul>
            {conflicts.map((conflict, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Conflicts are fixed per reply and may repeat.
              <li key={index}>{conflict}</li>
            ))}
          </ul>
        </div>
      )}
      {failed.length > 0 && (
        <p className="muted chat-team-failed">
          Couldn’t reach {failed.map(specialistLabel).join(", ")} this time, so their advice is missing.
        </p>
      )}
    </div>
  );
}

function ReplyText({ text }: { text: string }) {
  const blocks = useMemo(() => formatReply(text), [text]);
  if (blocks.length === 0) return null;
  return (
    <div className="chat-reply">
      {blocks.map((block, index) => {
        if (block.type === "list") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: Blocks are derived from fixed reply text.
            <ul className="chat-reply-list" key={index}>
              {block.items.map((item, itemIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: List items are fixed per reply and may repeat.
                <li key={itemIndex}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: Blocks are derived from fixed reply text.
          <p className={block.type === "label" ? "chat-label" : undefined} key={index}>
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function ReferenceNotes({ reference }: { reference: ImageReference }) {
  const rows: [string, string][] = [
    ["Composition", reference.composition],
    ["Lighting", reference.lighting],
    ["Camera angle", reference.cameraAngle],
    ["Colour", reference.colour],
    ["Setting", reference.environment],
    ["Mood", reference.mood],
    ["Shot ideas", reference.shotIdeas],
  ];
  const filled = rows.filter(([, value]) => value.trim());
  return (
    <div className="chat-reference">
      <p className="chat-reference-head">Reference image{reference.name ? `: ${reference.name}` : ""}</p>
      {filled.length > 0 && (
        <dl className="chat-reference-list">
          {filled.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function latestAgentMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "agent") return messages[index];
  }
  return undefined;
}

function AnswerOptions({
  options,
  disabled,
  onPick,
}: {
  options: string[];
  disabled: boolean;
  onPick: (option: string) => void;
}) {
  return (
    <fieldset className="answer-options">
      <legend className="sr-only">Suggested answers — pick one or type your own</legend>
      {options.map((option) => (
        <button key={option} className="quick-action answer-option" type="button" disabled={disabled} onClick={() => onPick(option)}>
          {option}
        </button>
      ))}
    </fieldset>
  );
}

function UserBubble({
  message,
  canEdit,
  busy,
  edited,
  onSave,
}: {
  message: ChatMessage;
  canEdit: boolean;
  busy: boolean;
  edited: boolean;
  onSave: (text: string) => boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const fieldId = `answer-edit-${message.id}`;
  const open = editing && canEdit;

  useEffect(() => {
    if (open) fieldRef.current?.focus();
    else if (wasEditing.current) editButtonRef.current?.focus();
    wasEditing.current = open;
  }, [open]);

  const trimmed = draft.trim();
  const saveDisabled = busy || !trimmed || trimmed === message.text.trim();

  function save() {
    if (saveDisabled) return;
    if (onSave(draft)) setEditing(false);
  }

  function onEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    }
  }

  if (open) {
    return (
      <div className="chat-bubble chat-user chat-user-editing">
        <label className="chat-edit-label" htmlFor={fieldId}>
          Edit your answer
        </label>
        <textarea
          id={fieldId}
          ref={fieldRef}
          rows={3}
          value={draft}
          maxLength={MAX_ANSWER_CHARACTERS}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onEditKeyDown}
        />
        <div className="chat-edit-actions">
          <button className="button secondary" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="button" type="button" disabled={saveDisabled} onClick={save}>
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-bubble chat-user">
      <p>{message.text}</p>
      {edited && (
        <div className="chat-user-meta">
          <span className="chat-edited">edited</span>
        </div>
      )}
      {canEdit && !busy && (
        <button
          ref={editButtonRef}
          className="chat-edit-btn"
          type="button"
          aria-label="Edit this answer"
          title="Edit this answer"
          onClick={() => {
            setDraft(message.text);
            setEditing(true);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function ConversationPanel({
  session,
  busy,
  error,
  input,
  transcribing,
  voiceError,
  canGeneratePlan,
  uploading,
  busyText,
  onInput,
  onSend,
  onQuickAction,
  onDiscoveryAction,
  onAnswerOption,
  onGeneratePlan,
  onAccept,
  onReject,
  onEditAnswer,
  onVoice,
  onVoiceActive,
  onUpload,
  onRetry,
}: {
  session: StorySession;
  busy: boolean;
  error: string;
  input: string;
  transcribing: boolean;
  voiceError: string;
  canGeneratePlan: boolean;
  uploading: UploadingKind | null;
  busyText?: string;
  onInput: (value: string) => void;
  onSend: () => void;
  onQuickAction: (message: string) => void;
  onDiscoveryAction: (label: string) => void;
  onAnswerOption: (option: string) => void;
  onGeneratePlan: () => void;
  onAccept: (message: ChatMessage) => void;
  onReject: (id: string) => void;
  onEditAnswer: (messageId: string, text: string) => boolean;
  onVoice: (file: File) => void;
  onVoiceActive: (active: boolean) => void;
  onUpload: (file: File) => void;
  onRetry: () => void;
}) {
  const logEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editedIds, setEditedIds] = useState<ReadonlySet<string>>(() => new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message when the log grows or a reply is pending.
  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session.messages.length, busy]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  }

  function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) onUpload(file);
  }

  const showEmptyRetry = session.messages.length === 0 && !busy;
  const discovery = session.phase === "discovery";
  const latestAgent = latestAgentMessage(session.messages);
  const optionsMessageId =
    discovery && session.pendingQuestion && !busy && latestAgent?.options?.length ? latestAgent.id : null;

  function saveAnswer(messageId: string, text: string): boolean {
    const saved = onEditAnswer(messageId, text);
    if (saved) setEditedIds((previous) => new Set(previous).add(messageId));
    return saved;
  }

  return (
    <section className="conversation-panel panel" aria-label="AI conversation">
      <div className="studio-chat-head">
        <div className="studio-chat-head-main">
          <h3>Creative director</h3>
          <p className="muted">
            {session.phase === "discovery"
              ? "Answer one question at a time. Your story builds up on the right as you go."
              : "Ask for any change in your own words. Nothing changes until you press Apply."}
          </p>
        </div>
        {discovery && canGeneratePlan && (
          <span className="tip">
            <button
              className="button generate-btn"
              type="button"
              disabled={busy}
              aria-label="Create shot plan"
              aria-describedby="generate-tip"
              onClick={onGeneratePlan}
            >
              Create shot plan
            </button>
            <span className="tip-text" role="tooltip" id="generate-tip">
              Turns your answers so far into a shot-by-shot plan. You can keep answering instead — nothing is locked in.
            </span>
          </span>
        )}
      </div>

      <div className="chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
        {session.messages.length === 0 ? (
          showEmptyRetry ? (
            <div className="chat-empty">
              <p className="muted">The creative director couldn’t open the conversation.</p>
              <button className="button secondary" type="button" onClick={onRetry}>
                Start the conversation
              </button>
            </div>
          ) : (
            <p className="muted chat-empty">Starting the conversation…</p>
          )
        ) : (
          session.messages.map((message) =>
            message.role === "user" ? (
              <UserBubble
                key={message.id}
                message={message}
                canEdit={discovery && message.answerIndex !== undefined}
                busy={busy}
                edited={editedIds.has(message.id)}
                onSave={(text) => saveAnswer(message.id, text)}
              />
            ) : (
              <div className="chat-bubble chat-agent" key={message.id}>
                {message.specialists && message.specialists.length > 0 && (
                  <p className="chat-consulted">Advice from: {message.specialists.map(specialistLabel).join(" · ")}</p>
                )}
                <ReplyText text={message.text} />
                {message.suggestion && <p className="muted chat-suggestion">{message.suggestion}</p>}
                {message.id === optionsMessageId && message.options && (
                  <AnswerOptions
                    options={message.options}
                    disabled={transcribing || uploading !== null}
                    onPick={onAnswerOption}
                  />
                )}
                {message.reference && <ReferenceNotes reference={message.reference} />}
                <TeamNotes message={message} />
                {message.changeSummary && message.changeSummary.length > 0 && (
                  <ul className="chat-changes">
                    {message.changeSummary.map((change, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Change bullets are fixed per proposal and may repeat.
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                )}
                {message.status === "pending" ? (
                  <>
                    <p className="chat-confirm" id={`confirm-${message.id}`}>
                      {proposalConfirmation(message.changeSummary)}
                    </p>
                    <div className="chat-proposal-actions">
                      <button
                        className="button"
                        type="button"
                        aria-describedby={`confirm-${message.id}`}
                        onClick={() => onAccept(message)}
                      >
                        Apply to story
                      </button>
                      <button className="button secondary" type="button" onClick={() => onReject(message.id)}>
                        Discard
                      </button>
                    </div>
                  </>
                ) : message.status ? (
                  <p className={`chat-status chat-status-${message.status}`}>
                    {message.status === "accepted" ? "Added to your story" : "Discarded"}
                  </p>
                ) : null}
              </div>
            ),
          )
        )}
        {busy && (
          <p className="muted chat-busy" role="status">
            {busyText ?? (discovery ? "The creative director is thinking…" : "Working on your request…")}
          </p>
        )}
        <div ref={logEnd} />
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="chat-compose">
        {discovery && (
          <fieldset className="quick-actions">
            <legend className="sr-only">Quick replies</legend>
            {DISCOVERY_ACTIONS.map((action) => (
              <button
                key={action.label}
                className="quick-action"
                type="button"
                disabled={
                  busy || transcribing || uploading !== null || (action.command !== "stop" && !session.pendingQuestion)
                }
                onClick={() => onDiscoveryAction(action.label)}
              >
                {action.label}
              </button>
            ))}
          </fieldset>
        )}
        {!discovery && (
          <fieldset className="quick-actions">
            <legend className="sr-only">Ask a film expert</legend>
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.label}
                className="quick-action"
                type="button"
                title={action.message}
                disabled={busy || transcribing || uploading !== null}
                onClick={() => onQuickAction(action.message)}
              >
                {action.label}
              </button>
            ))}
          </fieldset>
        )}
        <label className="sr-only" htmlFor="conversation-input">
          Message the creative director
        </label>
        <textarea
          id="conversation-input"
          ref={inputRef}
          rows={3}
          value={input}
          maxLength={discovery ? MAX_ANSWER_CHARACTERS : MAX_CHAT_MESSAGE_CHARACTERS}
          placeholder={session.phase === "discovery" ? "Type your answer…" : "Describe the change you want…"}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-compose-actions">
          <div className="composer-tools">
            <input
              ref={fileRef}
              className="sr-only"
              type="file"
              accept={ATTACH_ACCEPT}
              onChange={onPickFile}
            />
            <button
              className="icon-btn"
              type="button"
              aria-label={ATTACH_LABEL}
              title={ATTACH_LABEL}
              disabled={busy || transcribing || uploading !== null}
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49" />
              </svg>
            </button>
            <VoiceRecorder busy={busy} onActiveChange={onVoiceActive} onRecording={onVoice} />
          </div>
          <button
            className="button"
            type="button"
            disabled={busy || transcribing || uploading !== null || !input.trim()}
            onClick={onSend}
          >
            Send
          </button>
        </div>
        {uploading && (
          <p className="muted" role="status">
            {UPLOADING_LABELS[uploading]}
          </p>
        )}
        {transcribing && (
          <p className="muted" role="status">
            Transcribing voice note…
          </p>
        )}
        {voiceError && (
          <p className="error" role="alert">
            {voiceError}
          </p>
        )}
      </div>
    </section>
  );
}
