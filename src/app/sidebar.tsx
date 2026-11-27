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
                      <button className="sidebar-item-title" type="button" onClick={() => onSelect(session.id)}>
                        {session.title}
                      </button>
                      <span className="sidebar-item-actions">
                        <button
                          className="sidebar-action"
                          type="button"
                          aria-label={`Rename ${session.title}`}
                          onClick={() => startRename(session)}
                        >
                          Rename
                        </button>
                        <button
                          className="sidebar-action"
                          type="button"
                          aria-label={`Delete ${session.title}`}
                          onClick={() => onDelete(session.id)}
                        >
                          Delete
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
          className={`sidebar-nav${view === "usage" ? " sidebar-nav-active" : ""}`}
          type="button"
          onClick={() => onNav("usage")}
        >
          Token usage
        </button>
        <button
          className={`sidebar-nav${view === "settings" ? " sidebar-nav-active" : ""}`}
          type="button"
          onClick={() => onNav("settings")}
        >
          Settings
        </button>
      </nav>
    </aside>
  );
}
