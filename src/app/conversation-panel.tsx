"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { VoiceRecorder } from "./voice-recorder";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/story-input";
import type { ChatMessage, StorySession } from "@/lib/session";

export function ConversationPanel({
  session,
  busy,
  error,
  input,
  transcribing,
  voiceError,
  canGeneratePlan,
  onInput,
  onSend,
  onGeneratePlan,
  onAccept,
  onReject,
  onVoice,
  onVoiceActive,
  onRetry,
}: {
  session: StorySession;
  busy: boolean;
  error: string;
  input: string;
  transcribing: boolean;
  voiceError: string;
  canGeneratePlan: boolean;
  onInput: (value: string) => void;
  onSend: () => void;
  onGeneratePlan: () => void;
  onAccept: (message: ChatMessage) => void;
  onReject: (id: string) => void;
  onVoice: (file: File) => void;
  onVoiceActive: (active: boolean) => void;
  onRetry: () => void;
}) {
  const logEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  const showEmptyRetry = session.messages.length === 0 && !busy;

  return (
    <section className="conversation-panel panel" aria-label="AI conversation">
      <div className="studio-chat-head">
        <h3>Creative director</h3>
        <p className="muted">
          {session.phase === "discovery"
            ? "Answer one question at a time. The story document fills in as you talk."
            : "Ask for changes in plain language. Review each proposal before it updates the document."}
        </p>
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
              <div className="chat-bubble chat-user" key={message.id}>
                <p>{message.text}</p>
              </div>
            ) : (
              <div className="chat-bubble chat-agent" key={message.id}>
                <p className="chat-reply">{message.text}</p>
                {message.suggestion && <p className="muted chat-suggestion">{message.suggestion}</p>}
                {message.changeSummary && message.changeSummary.length > 0 && (
                  <ul className="chat-changes">
                    {message.changeSummary.map((change, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Change bullets are fixed per proposal and may repeat.
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                )}
                {message.status === "pending" ? (
                  <div className="chat-proposal-actions">
                    <button className="button" type="button" onClick={() => onAccept(message)}>
                      Apply to document
                    </button>
                    <button className="button secondary" type="button" onClick={() => onReject(message.id)}>
                      Discard
                    </button>
                  </div>
                ) : message.status ? (
                  <p className={`chat-status chat-status-${message.status}`}>
                    {message.status === "accepted" ? "Applied to the document" : "Discarded"}
                  </p>
                ) : null}
              </div>
            ),
          )
        )}
        {busy && (
          <p className="muted chat-busy" role="status">
            The creative director is thinking…
          </p>
        )}
        <div ref={logEnd} />
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {session.phase === "discovery" && canGeneratePlan && (
        <div className="chat-generate">
          <p className="muted">
            {session.readyToPlan
              ? "Enough gathered — ready when you are."
              : "You can keep answering, or build the plan now."}
          </p>
          <button className="button" type="button" disabled={busy} onClick={onGeneratePlan}>
            Generate shot plan
          </button>
        </div>
      )}

      <div className="chat-compose">
        <label className="sr-only" htmlFor="conversation-input">
          Message the creative director
        </label>
        <textarea
          id="conversation-input"
          ref={inputRef}
          rows={3}
          value={input}
          maxLength={MAX_CHAT_MESSAGE_CHARACTERS}
          placeholder={session.phase === "discovery" ? "Type your answer…" : "Describe the change you want…"}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-compose-actions">
          <VoiceRecorder onActiveChange={onVoiceActive} onRecording={onVoice} />
          <button
            className="button"
            type="button"
            disabled={busy || transcribing || !input.trim()}
            onClick={onSend}
          >
            Send
          </button>
        </div>
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
