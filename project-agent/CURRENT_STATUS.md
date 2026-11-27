# Current status

**Last updated:** 2026-11-27, after live integration and end-to-end verification. Checkpoint commit `2a4621b` on branch `initial-start` (not pushed). Update this file after every major phase.

## Current working tree — Phase 4, 5 and 6 handoff

The work after the checkpoint is implemented in the working tree and is the current source of truth. It adds the 20-category `StoryContext` discovery controller, stop/skip/you-decide commands, a real OpenAI-backed Creative Director with Story, Camera, Sound, Editing and Consistency specialists, selective parallel calls, image-reference analysis, scoped scene revisions, and draft/final filmmaking-blueprint exports in PDF and DOCX. The plan call receives edited answers, collected details and context; original dialogue is allowed.

On 2026-11-27, the code-level handoff validation passed: `npm test` (116 tests), `npm run lint`, `npm run typecheck` and `npm run build`. The New project header/session-selection mismatch is fixed, and request busy/error state is now tied to the session that started the request. The Phase 4–6 paths still need one consolidated browser run and a live image-analysis call before they can be marked browser- or live-API-verified.

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

## Uncommitted since checkpoint `2a4621b`

- **Story Editor reworked to read-first (clutter reduction).** Default is a scannable read view (logline, intent, character/location lists, compact shot cards). Editing is opt-in per section: an **Edit/Done** toggle on *Overview* (covers title, logline, intent, characters, locations) and one per **scene**; inputs render only for the section being edited. **Scenes are collapsible** (chevron + shot count). Same `onEditPlan`/`onTitleChange` plumbing, so manual edits and Apply/Discard are unchanged. Files: `src/app/story-editor.tsx` (rewrite), `src/app/globals.css` (12 new selectors). Verification: **code-level** + lint/typecheck/test/build pass; **not browser-verified yet**.
- **Usage now records the real model id.** `plan`, `refine`, `director` and `transcribe` record `response.model` (the model the API actually returned) instead of the hardcoded constant, falling back to the constant if absent. The Token usage header shows the distinct real models from records, falling back to `STORY_MODEL`/`TRANSCRIPTION_MODEL` before any call. Request model (what we ask for) is unchanged. Files: `api/story/{plan,director,transcribe}/route.ts`, `server/refine.ts`, `usage-view.tsx`. Verification: **code-level** + lint/typecheck/test/build; **not live-API-verified** (can't confirm the exact returned id from here).
- **Story Editor project title is read-only** (set at New Chat, renamed in the sidebar); fixes the empty-title bug. Files: `story-editor.tsx`, `studio-app.tsx`.
- **Conversation composer + Generate control reworked.** "Generate shot plan" moved out of the banner into a small **Generate plan** button in the panel header (opposite the title), with a hover/focus **tooltip** explaining what it does. Composer now uses **icon-only** controls: a **paperclip** attach button and a **mic** record button (no text labels, `aria-label` + `title` kept). Attach imports a **.txt/.pdf** via `importDocument` (reuses the previously-unused `/api/story/import` for PDF, `file.text()` for TXT) and inserts the text into the composer, truncated to the phase limit (2,000 discovery / 4,000 refine). Files: `conversation-panel.tsx`, `voice-recorder.tsx`, `studio-agent.ts` (+`importDocument`), `studio-app.tsx` (+`handleUpload`), `globals.css`. Verification: **code-level** + lint/typecheck/test/build pass; **not browser-verified**.
- Earlier UX passes (also post-checkpoint): sidebar collapse toggle moved into the sidebar header; token-budget meter on the usage view with a budget setting; ChatGPT-style focused Settings screen (section nav + Back to app); read-first Story Editor.

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
