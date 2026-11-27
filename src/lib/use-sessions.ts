"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  MAX_SESSION_TITLE,
  parseSessions,
  serializeSessions,
  SESSIONS_STORAGE_KEY,
  type StorySession,
} from "@/lib/session";

const SAVE_DEBOUNCE_MS = 400;

export type SessionStore = {
  hydrated: boolean;
  sessions: StorySession[];
  activeId: string | null;
  active: StorySession | undefined;
  storageWarning: string;
  create: (title: string) => string;
  select: (id: string) => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  update: (id: string, updater: (session: StorySession) => StorySession) => void;
  clearAll: () => void;
};

export function useSessions(): SessionStore {
  const [sessions, setSessions] = useState<StorySession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load once on the client. Keeps server and first client render identical (no hydration mismatch).
  useEffect(() => {
    try {
      const loaded = parseSessions(window.localStorage.getItem(SESSIONS_STORAGE_KEY));
      setSessions(loaded.sessions);
      setActiveId(loaded.activeId);
    } catch {
      setStorageWarning("This browser blocked local storage, so sessions won’t be saved after you leave.");
    } finally {
      setHydrated(true);
    }
  }, []);

  // Debounced, quota-safe persistence.
  useEffect(() => {
    if (!hydrated) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        const payload = JSON.stringify(serializeSessions(sessions, activeId));
        window.localStorage.setItem(SESSIONS_STORAGE_KEY, payload);
        setStorageWarning("");
      } catch {
        setStorageWarning("Local storage is full or unavailable — recent changes may not be saved. Delete old sessions to free space.");
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [sessions, activeId, hydrated]);

  const create = useCallback((title: string) => {
    const session = createSession(title);
    setSessions((previous) => [session, ...previous]);
    setActiveId(session.id);
    return session.id;
  }, []);

  const select = useCallback((id: string) => setActiveId(id), []);

  const rename = useCallback((id: string, title: string) => {
    const clean = title.trim().slice(0, MAX_SESSION_TITLE);
    if (!clean) return;
    setSessions((previous) =>
      previous.map((session) => (session.id === id ? { ...session, title: clean, updatedAt: Date.now() } : session)),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setSessions((previous) => {
      const next = previous.filter((session) => session.id !== id);
      setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current));
      return next;
    });
  }, []);

  const update = useCallback((id: string, updater: (session: StorySession) => StorySession) => {
    setSessions((previous) =>
      previous.map((session) => (session.id === id ? { ...updater(session), updatedAt: Date.now() } : session)),
    );
  }, []);

  const clearAll = useCallback(() => {
    setSessions([]);
    setActiveId(null);
  }, []);

  const active = useMemo(() => sessions.find((session) => session.id === activeId), [sessions, activeId]);

  return { hydrated, sessions, activeId, active, storageWarning, create, select, rename, remove, update, clearAll };
}
