"use client";

import { useState, type KeyboardEvent } from "react";
import { MAX_SESSION_TITLE, type StorySession } from "@/lib/session";

export type StudioView = "chat" | "settings" | "usage";

export function Sidebar({
  sessions,
  activeId,
  view,
  open,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
  onNav,
  onClose,
}: {
  sessions: StorySession[];
  activeId: string | null;
  view: StudioView;
  open: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onNav: (view: StudioView) => void;
  onClose: () => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function startRename(session: StorySession) {
    setRenamingId(session.id);
    setDraft(session.title);
  }

  function commitRename() {
    if (renamingId && draft.trim()) onRename(renamingId, draft);
    setRenamingId(null);
    setDraft("");
  }

  function onRenameKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      setRenamingId(null);
      setDraft("");
    }
  }

  return (
    <aside className={`sidebar${open ? " sidebar-open" : ""}`} aria-label="Sessions and navigation">
      <div className="sidebar-top">
        <button className="app-menu" type="button" aria-label="Hide sidebar" aria-expanded={true} onClick={onClose}>
          ☰
        </button>
        <span className="sidebar-brand">Story Studio</span>
      </div>

      <button className="button sidebar-new" type="button" onClick={onNewChat}>
        + New chat
      </button>

      <nav className="sidebar-sessions" aria-label="Chat sessions">
        <p className="sidebar-section-label">Sessions</p>
        {sessions.length === 0 ? (
          <p className="muted sidebar-empty">No sessions yet.</p>
        ) : (
          <ul className="sidebar-list">
            {sessions.map((session) => {
              const isActive = session.id === activeId && view === "chat";
              return (
                <li className={`sidebar-item${isActive ? " sidebar-item-active" : ""}`} key={session.id}>
                  {renamingId === session.id ? (
                    <input
                      className="editor-input sidebar-rename"
                      // biome-ignore lint/a11y/noAutofocus: Focus belongs on the rename field the user just opened.
                      autoFocus
                      type="text"
                      aria-label="Rename session"
                      value={draft}
                      maxLength={MAX_SESSION_TITLE}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={onRenameKey}
                      onBlur={commitRename}
                    />
                  ) : (
                    <>
                      <button
                        className="sidebar-item-title"
                        type="button"
                        title={session.title}
                        onClick={() => onSelect(session.id)}
                      >
                        {session.title}
                      </button>
                      <span className="sidebar-item-actions">
                        <button
                          className="sidebar-action"
                          type="button"
                          aria-label={`Rename ${session.title}`}
                          title="Rename"
                          onClick={() => startRename(session)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </button>
                        <button
                          className="sidebar-action"
                          type="button"
                          aria-label={`Delete ${session.title}`}
                          title="Delete"
                          onClick={() => onDelete(session.id)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 6h18" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          </svg>
                        </button>
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <nav className="sidebar-footer" aria-label="Views">
        <button
          className={`sidebar-nav${view === "settings" || view === "usage" ? " sidebar-nav-active" : ""}`}
          type="button"
          onClick={() => onNav("settings")}
        >
          Settings
        </button>
      </nav>
    </aside>
  );
}
