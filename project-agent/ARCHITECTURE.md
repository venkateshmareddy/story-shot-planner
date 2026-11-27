# Architecture — AI Creative Studio

Verified against the code on 2026-11-27. The code is the source of truth; if this file disagrees with it, fix this file.

## Overview

One Next.js 16 App Router application. The Studio is a set of React client components that keep all session state in the browser (`localStorage`). Stateless server route handlers call OpenAI. There is no database and no authentication.

```
Browser (client components)                        Server (route handlers, Node runtime)
StudioApp ─ useSessions()    ⇄ localStorage         POST /api/story/plan        step: interview | plan | draft
   │      └ useTokenBudget() ⇄ localStorage         POST /api/story/refine
   └─ studio-agent.ts ── fetch ──────────────────▶  POST /api/story/transcribe
                                                    POST /api/story/import      (not called by the UI)
                                                         │
                                  composeInstructions() + zodTextFormat ──▶ OpenAI (gpt-6.2-sol, gpt-transcribe)
```

## Components (`src/app`)

| Component | Responsibility |
|---|---|
| `layout.tsx` | Root layout, metadata, imports `globals.css` |
| `page.tsx` | Renders `<StudioApp />` |
| `studio-app.tsx` | Orchestrator. Owns view (`chat` / `settings`), New Chat form, input, busy/error, voice state, sidebar visibility. Wires `useSessions()`, `useTokenBudget()` and the `studio-agent` calls. |
| `sidebar.tsx` | Session history (open, inline rename, delete with `window.confirm`), New chat, nav to Token usage and Settings |
| `conversation-panel.tsx` | Chat log, refine proposals with **Apply to document** / **Discard**, Generate shot plan button, composer, voice recorder |
| `voice-recorder.tsx` | `MediaRecorder` capture (webm/opus, webm or mp4 at 64 kbps), stops at 4 MB |
| `story-editor.tsx` | Editable story document (see the user flow below) |
| `settings-screen.tsx` | Settings shell with sections `usage` / `preferences` / `data` and "Back to app" |
| `settings-view.tsx` | `PreferencesSection` (token budget, formats, models) and `DataSection` (session count, Delete all sessions) |
| `usage-view.tsx` | Model IDs, request/input/output/total token totals, budget meter (warns at 75%, flags at 100%), per-session table |

## User flow as implemented

1. **New Chat** asks only for a project title (max 120 characters). It creates the session and immediately calls `askInterview(title, [])`. If that fails, the empty chat offers "Start the conversation" to retry.
2. **Interview loop.** One question per turn. Sending appends `{question: pendingQuestion, answer}` to `answered` and calls `askInterview(title, answered)`; on failure it rolls back and restores the input. Agent turns show the note and question, with the rationale muted. When the model says it is complete, `readyToPlan` is set; the server also forces completion on a duplicate question or at 12 answers.
3. **Planning** is manual. "Generate shot plan" appears in the `discovery` phase once there is at least one answer and calls `generatePlan(title, answered)`. Success moves the session to the `refining` phase; there is no way back to discovery.
4. **Story Editor.** The project title is always editable. Before a plan exists it shows a read-only "Discovered so far" list. After planning, editable fields are: logline, intent; characters (name, role, look, personality, voice); locations (name, description); scene titles; shots (action, seconds, framing, camera, characters, location, emotion, sound) and their dialogue (speaker, line, delivery). Every list supports add and remove. Review notes are read-only. Scene and shot IDs (`S01`, `S01_SH01`) come from list position.
5. **Refine.** Each chat message in the `refining` phase creates a pending proposal (reply, change summary, full proposed plan). Apply replaces the plan with the proposal's copy; Discard marks it rejected. Nothing is applied without approval.
6. **Settings and usage** as listed in the components table.
7. **Voice.** Recording → `transcribeVoice(file)` → `/api/story/transcribe`; the transcript is appended to the composer (not sent automatically) and its usage is recorded.

## State and persistence

- `StorySession` (`src/lib/session.ts`): `id, title, createdAt, updatedAt, phase ('discovery' | 'refining'), readyToPlan, pendingQuestion, answered[{question, answer}], collected[{label, detail}], messages[ChatMessage], plan | null, usage[UsageRecord]`.
- `ChatMessage`: `id, role, text, suggestion?, changeSummary?, proposedPlan?, status? ('pending' | 'accepted' | 'rejected')`.
- Sessions: `localStorage["story-studio.sessions.v1"]` = `{version: 1, activeId, sessions}`. Saves are debounced by 400 ms; `proposedPlan` is dropped from resolved messages before saving. A version mismatch or invalid JSON loads an empty list. Load and save failures set `storageWarning`, shown as an alert.
- Token budget: `localStorage["story-studio.tokenBudget.v1"]`, default 100,000; storage failures are ignored.
- The `SessionStore` interface returned by `useSessions()` is the seam for replacing localStorage with a server store later (D-008).

## AI integration

| Client call (`src/lib/studio-agent.ts`) | Route | Payload |
|---|---|---|
| `askInterview(story, answered)` | `/api/story/plan` | `{step: "interview", story, answered}` — `story` is the project title |
| `generatePlan(story, answers)` | `/api/story/plan` | `{step: "plan", story, answers}` — `story` is the project title |
| `refinePlan(plan, history, message)` | `/api/story/refine` | `{plan, messages (last 40), message}` |
| `transcribeVoice(file)` | `/api/story/transcribe` | audio bytes, `X-Audio-Extension` header |

- No client call sends `format`; the server defaults to `short_film`.
- Prompts: `composeInstructions(step, format)` in `src/lib/server/prompts.ts` joins `SOURCE_RULES`, `CRAFT_PRINCIPLES`, `STAGE_BASE[step]` and `FORMAT_PROMPTS[format][step]`.
- Formats: `src/lib/formats.ts` registers six; only `short_film` is enabled. `formatSchema` rejects disabled or unknown formats.
- Models: `src/lib/models.ts` — `STORY_MODEL = "gpt-6.2-sol"`, `TRANSCRIPTION_MODEL = "gpt-transcribe"`.
- OpenAI client (`src/lib/server/openai.ts`): created only when `OPENAI_API_KEY` is set; `maxRetries: 0`, 90 s timeout. Calls use the Responses API with `store: false` and Zod structured outputs.
- `max_output_tokens`: draft 3,000 · interview 1,500 · plan 8,000 · refine 10,000.
- Interview turns are resolved by the pure `resolveInterviewTurn` in `src/lib/interview.ts`.
- Usage: every route returns `toUsageRecord(step, model, response.usage)`; the client appends it to `session.usage`.
- Errors: `modelError` maps 401/403/404 → 503, 429 → 429, anything else → 502; `jsonError(message, status)` returns `{error}`. Logs contain usage metadata and error status/code only.

## API routes (all `POST`, Node runtime)

| Route | Input and limits | Output | Status codes |
|---|---|---|---|
| `/api/story/plan` | JSON ≤ 512 KB, `planningRequest` (step `draft` / `interview` / `plan`) | Interview: resolved turn + usage. Plan: shot plan + usage. Draft: `{story, reason}` + usage | 400, 413, 503 (no key), 502 (invalid shot, or dialogue not found verbatim in `story`), model errors |
| `/api/story/refine` | JSON ≤ 1 MB, `refineRequest` | `{reply, changeSummary, plan, usage}` | 400, 413, 503, 502 |
| `/api/story/transcribe` | mp3 / wav / m4a / webm, ≤ 4 MB | `{text, usage}` | 415, 413, 400 (empty), 422 (no speech or too long), 503 |
| `/api/story/import` | PDF ≤ 4 MB, ≤ 30 pages (unpdf) | `{text}` | 415, 413, 400, 422 |

`/api/story/import` and the `draft` step are not called by any current UI.

## Shared libraries (`src/lib`)

| File | Contents |
|---|---|
| `session.ts` | `StorySession` and `ChatMessage` types, `createSession`, `newId`, `totalUsage`, localStorage serialise/parse |
| `use-sessions.ts` | `useSessions()` hook — localStorage-backed `SessionStore` |
| `use-token-budget.ts` | Token budget hook (localStorage) |
| `studio-agent.ts` | Client wrappers for the AI routes |
| `story-planning.ts` | Zod request schemas (`planningRequest`, `refineRequest`, `interviewExchange`) and output schemas (`draftOutput`, `planOutput`, `refineOutput`) |
| `interview.ts` | `interviewTurnOutput` schema, `resolveInterviewTurn`, `MAX_INTERVIEW_TURNS` (12) — imports only zod |
| `formats.ts` | Format registry, `DEFAULT_FORMAT`, `formatSchema` — imports only zod |
| `models.ts` | Model ID constants |
| `usage.ts` | `UsageRecord`, `toUsageRecord`, `isUsageRecord` |
| `story-input.ts` | Shared size and length limits |
| `server/openai.ts` | OpenAI client factory, `jsonError`, `modelError` |
| `server/prompts.ts` | `SOURCE_RULES`, prompt bases and format modifiers, `composeInstructions` |
| `server/read-body.ts` | Size-bounded request body reader |

## Design system

`:root` tokens in `src/app/globals.css`: `--background #f5f2eb`, `--paper #fffdfa`, `--ink #231d17`, `--muted #62594e`, `--line #d8cfc2`, `--accent #893a26`, `--highlight #fbefe7`, `--bubble-user #efe6d8`; `color-scheme: light`. Body text uses `system-ui`; headings and `.studio-title` use Georgia. No web fonts and no dark mode. Breakpoints at 35, 48 and 60 rem, plus `prefers-reduced-motion`.

## Tests

`npm test` runs `node --test test/*.test.ts`:

- `formats.test.ts` — default format, enabled list, `formatSchema` accept/reject and message
- `prompts.test.ts` — `composeInstructions` determinism and coverage for every step × format, key plan directives
- `interview.test.ts` — `resolveInterviewTurn` (ask, duplicate, cap, default recommendation), schema parsing, short-film interview instructions

Not covered: route handlers, `session.ts`, the hooks and the UI. CI does not run the tests.
