# Current status

**Last updated:** 2026-11-27, after live integration and end-to-end verification. Checkpoint commit `2a4621b` on branch `initial-start` (not pushed). Update this file after every major phase.

Verification levels: **live-API** (real OpenAI call observed) · **browser (real AI)** (driven in Chrome against real model responses) · **browser (UI, AI mocked)** (driven in Chrome with `/api/story/*` mocked) · **unit-tested** (`npm test`) · **code-level** (read in the code, not run).

## Phases

| Phase | State |
|---|---|
| Phase 1 — format registry, composable prompts | Done |
| Phase 2 — adaptive one-question interview | Done (editing earlier answers is not in the UI — see below) |
| PostgreSQL persistence | Built, then removed at the user's request (D-008) |
| Cleanup audit | Done |
| Agent workspace (`CLAUDE.md`, `.claude/`, `project-agent/`) | Done |
| Live integration and end-to-end verification | Done — see results below |

## Verified working

| Capability | Verified by |
|---|---|
| Key loads on the server; `gpt-6.2-sol` and `gpt-transcribe` available | live-API (`GET /v1/models` → 200) |
| New Chat asks only for a title; conversation starts | browser (real AI) |
| One adaptive question per turn, no repeats, follow-ups reflect answers | browser (real AI), 9 interview calls, 3.7–7.2 s each |
| Generate shot plan → Story Editor shows characters, locations, scenes, shots | browser (real AI), 75 s, 3 characters / 2 locations / 3 scenes / 20 shots |
| Manual edits in the Story Editor persist | browser (real AI) |
| Refine proposal; editor unchanged while pending; Discard; Apply | browser (real AI), ~51 s per refine |
| Apply asks for confirmation if the story changed after the request; dismissing keeps the edits | browser (UI, AI mocked) |
| Error state: a failed refine shows an alert and restores the typed text | browser (UI, mocked 502) |
| Reload restores sessions, chat and editor content | browser (real AI) |
| Second session isolated; rename; delete with confirm | browser (real AI) |
| Token usage totals match the network responses exactly; budget meter | browser (real AI) |
| Voice: fake-mic recording → transcript in the composer | browser (real AI) |
| Settings show `gpt-6.2-sol`, `gpt-transcribe` and the token budget | browser (real AI) |
| Mobile 390×844: Send and Record tappable, editor reachable, no horizontal overflow, drawer closes after selection | browser (UI, AI mocked) |
| Desktop sidebar stays open after New chat, Create, select session, Settings → Back | browser (UI, AI mocked) |
| App icon `/icon.svg` served and rendered; no favicon 404 | browser |
| Request validation and error messages (400/413/415) | live-API (no model call) |
| Format registry, prompt composition, interview resolver | unit-tested (20/20) |

No console errors, page errors or unexpected navigations in the browser runs.

## Story-planning input flow (verified, unchanged)

"Generate shot plan" sends `{step: "plan", story: <project title>, answers: <interview Q&A>}` (`studio-app.tsx:206` → `studio-agent.ts` `generatePlan`) — captured in the browser. The route passes it to the model with the short-film plan prompt.

- The **collected creative details are not sent** to plan generation; they are only displayed.
- Text sent after the interview completes is not sent either.
- The plan prompt forbids inventing dialogue, and the route only accepts dialogue copied verbatim from `story` — which is just the title. **Studio plans therefore cannot contain dialogue** (a plan that does gets a 502). Needs a product decision (affects D-015).

## Known gaps and bugs

1. **Decision needed — plan input.** See above: no dialogue, and collected details unused.
2. **Missing — editing earlier interview answers** (MVP requirement). Smallest proposal, not implemented: store `answerIndex` on the user `ChatMessage` in `sendDiscovery`; add `editAnswer(index, text)` in `studio-app.tsx` that updates `answered[index]` and the message text without a model call; in `conversation-panel.tsx`, show an Edit control on user bubbles with an `answerIndex` during the discovery phase that swaps the text for a textarea (max 2,000 characters) with Save/Cancel. About 40 lines across `session.ts`, `studio-app.tsx`, `conversation-panel.tsx`.
3. **Minor** — The composer allows 4,000-character answers, but interview answers are capped at 2,000, so long answers get a 400.
4. **Minor** — Model questions over 500 characters aren't truncated on the server, so the next turn fails validation.
5. **Minor** — Transcription is recorded as 0 tokens (counted as a request). Likely duration-based usage from `gpt-transcribe`; unconfirmed.
6. **Minor** — A disabled format gets the generic 400 message instead of the format-specific one.
7. **Minor** — Voice error text mentions "upload audio", but there is no upload UI.
8. **Minor** — The editor lets the project title be emptied.
9. **Cosmetic** — The sidebar's Token usage nav item never shows as active; the error alert stays until the next send.

Cleanup candidates: about 45 unused CSS selectors; `/api/story/import` and the `draft` step are unused by the UI; `DiscoveryExchange` duplicates `InterviewExchange`; `onVoiceActive` is a no-op; `useTokenBudget().hydrated` is unused; `README.md` is out of date.

## Fixed in this round (browser-verified)

Mobile editor no longer covers Send/Record · Apply confirms before replacing edits made while a proposal was pending · desktop sidebar stays open · app icon added · SVG accessibility lint error fixed.

## API configuration

Key valid as of 2026-11-27. Both model IDs verified. Secrets are read only on the server; logs carry usage metadata only. No API blockers.

## Validation (on commit `2a4621b`)

| Check | Result |
|---|---|
| `npm run lint` | Pass — 29 files, 0 errors |
| `npm run typecheck` | Pass |
| `npm test` | Pass — 20/20 |
| `npm run build` | Pass |
| CI | Runs lint, typecheck and build — not `npm test` |

## Next recommended task

Decide the plan-input question (send collected details; allow original dialogue when there is no source story) and implement editing of earlier answers. Then push the branch and add `npm test` to CI.
