"use client";

import { useCallback, useEffect, useState } from "react";

const BUDGET_STORAGE_KEY = "story-studio.tokenBudget.v1";
export const DEFAULT_TOKEN_BUDGET = 100_000;

export type TokenBudget = {
  budget: number;
  hydrated: boolean;
  setBudget: (value: number) => void;
};

/** A soft, browser-local token budget used only to render the usage meter. */
export function useTokenBudget(): TokenBudget {
  const [budget, setBudgetState] = useState(DEFAULT_TOKEN_BUDGET);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BUDGET_STORAGE_KEY);
      if (raw !== null) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 0) setBudgetState(parsed);
      }
    } catch {
      // Ignore unavailable storage; fall back to the default.
    } finally {
      setHydrated(true);
    }
  }, []);

  const setBudget = useCallback((value: number) => {
    const clean = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    setBudgetState(clean);
    try {
      window.localStorage.setItem(BUDGET_STORAGE_KEY, String(clean));
    } catch {
      // Best effort; the in-memory value still drives the UI this session.
    }
  }, []);

  return { budget, hydrated, setBudget };
}
