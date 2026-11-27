# Architecture — AI Creative Studio

Verified against the code on 2026-11-27. The code is the source of truth; if this file disagrees with it, fix this file.

## Overview

One Next.js 16 App Router application. The Studio is a set of React client components that keep all session state in the browser (`localStorage`). Stateless server route handlers call OpenAI. There is no database and no authentication.

```
Browser (client components)                        Server (route handlers, Node runtime)
StudioApp ─ useSessions()    ⇄ localStorage         POST /api/story/plan        step: interview | plan | draft
   │      └ useTokenBudget() ⇄ localStorage         POST /api/story/refine
   └─ studio-agent.ts ── fetch ──────────────────▶  POST /api/story/director    orchestrator → specialists (src/lib/agents)
                                                    POST /api/story/transcribe
                                                    POST /api/story/refine      (fallback used by the director)
                                                    POST /api/story/import      document attachment
                                                    POST /api/story/image       reference-image analysis
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
| `conversation-panel.tsx` | Chat log; `UserBubble` with Edit/Save/Cancel for interview answers (discovery only, no AI call); `TeamNotes` inside the agent bubble (consulted specialists, grouped recommendations, disagreements, failed specialists); proposals with **Apply to document** / **Discard**; Generate shot plan button; composer; voice recorder |
| `voice-recorder.tsx` | `MediaRecorder` capture (webm/opus, webm or mp4 at 64 kbps), stops at 4 MB |
| `story-editor.tsx` | Story document: read-first view with per-section Edit/Done toggles and collapsible scenes (see the user flow below) |
| `settings-screen.tsx` | Settings shell with sections `usage` / `preferences` / `data` and "Back to app" |
| `settings-view.tsx` | `PreferencesSection` (token budget, formats, models) and `DataSection` (session count, Delete all sessions) |
| `usage-view.tsx` | Model IDs, request/input/output/total token totals, budget meter (warns at 75%, flags at 100%), per-session table |
| `export-menu.tsx` | Draft and confirmed-final PDF/DOCX blueprint exports. |

## User flow as implemented

1. **New Chat** asks only for a project title (max 120 characters). It creates the session and immediately calls `askInterview(title, [])`. If that fails, the empty chat offers "Start the conversation" to retry.
2. **Interview loop.** One question per turn. Sending appends `{question: pendingQuestion, answer}` to `answered` (the user message stores its `answerIndex`) and calls `askInterview(title, answered)`; on failure it rolls back and restores the input. Answers are capped at 2,000 characters. During discovery, any earlier answer can be edited in place — `editAnswer` updates `answered[i]` and the message text with no AI call, and later turns and planning use the edit. When the model says it is complete, `readyToPlan` is set; the server also forces completion on a duplicate question or at 12 answers.
3. **Planning** is manual. "Generate shot plan" appears in the `discovery` phase once there is at least one answer and calls `generatePlan(title, answered, collected)`. The model may write original dialogue (D-017). Success moves the session to the `refining` phase; there is no way back to discovery.
4. **Story Editor.** The project title is always editable. Before a plan exists it shows a read-only "Discovered so far" list. After planning, editable fields are: logline, intent; characters (name, role, look, personality, voice); locations (name, description); scene titles; shots (action, seconds, framing, camera, characters, location, emotion, sound) and their dialogue (speaker, line, delivery). Every list supports add and remove. Review notes are read-only. Scene and shot IDs (`S01`, `S01_SH01`) come from list position.
5. **Creative Director.** Each chat message in the `refining` phase goes to `askDirector` → `/api/story/director` (see the multi-agent section). The reply is one agent message carrying the specialists consulted, their recommendations and any disagreements. If the response includes a plan, it is a pending proposal: Apply replaces the plan (with a confirmation if the story changed since the request), Discard marks it rejected. Advice-only replies have no Apply/Discard. Nothing is applied without approval.
6. **Settings and usage** as listed in the components table.
7. **Voice and references.** Recording → `transcribeVoice(file)` → `/api/story/transcribe`; the transcript is appended to the composer. PNG, JPEG and WebP references are analysed server-side and their text analysis reaches the Camera specialist; raw image bytes are not stored.
8. **Blueprint export.** Draft PDF/DOCX exports work at any stage. Final exports require a plan with a shot and an explicit confirmation.

## State and persistence

- `StorySession` (`src/lib/session.ts`): `id, title, createdAt, updatedAt, phase ('discovery' | 'refining'), readyToPlan, pendingQuestion, answered[{question, answer}], collected[{label, detail}], messages[ChatMessage], plan | null, usage[UsageRecord], context?, references?`.
- `ChatMessage`: `id, role, text, suggestion?, changeSummary?, proposedPlan?, status? ('pending' | 'accepted' | 'rejected')`.
- Sessions: `localStorage["story-studio.sessions.v1"]` = `{version: 1, activeId, sessions}`. Saves are debounced by 400 ms; `proposedPlan` is dropped from resolved messages before saving. A version mismatch or invalid JSON loads an empty list. Load and save failures set `storageWarning`, shown as an alert.
- Token budget: `localStorage["story-studio.tokenBudget.v1"]`, default 100,000; storage failures are ignored.
- The `SessionStore` interface returned by `useSessions()` is the seam for replacing localStorage with a server store later (D-008).

## AI integration

| Client call (`src/lib/studio-agent.ts`) | Route | Payload |
|---|---|---|
| `askInterview(story, answered)` | `/api/story/plan` | `{step: "interview", story, answered}` — `story` is the project title |
| `generatePlan(story, answers, collected)` | `/api/story/plan` | `{step: "plan", story, answers, collected}` — `story` is the project title |
| `askDirector(request)` | `/api/story/director` | `DirectorRequest`: `{plan, messages (last 40), message, answers, collected}` |
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
| `/api/story/plan` | JSON ≤ 512 KB, `planningRequest` (step `draft` / `interview` / `plan`; plan accepts `collected` ≤ 40) | Interview: resolved turn + usage. Plan: shot plan + usage. Draft: `{story, reason}` + usage | 400, 413, 503 (no key), 502 (`findPlanProblem`: empty scenes/shots, bad seconds, blank dialogue), model errors |
| `/api/story/director` | JSON ≤ 1 MB, `directorRequest` | `DirectorResponse` (`src/lib/agents/types.ts`) | 400, 413, 503, 502 (all specialists failed), model errors |
| `/api/story/refine` | JSON ≤ 1 MB, `refineRequest` | `{reply, changeSummary, plan, usage}` — logic shared with the director via `src/lib/server/refine.ts` | 400, 413, 503, 502 |
| `/api/story/transcribe` | mp3 / wav / m4a / webm, ≤ 4 MB | `{text, usage}` | 415, 413, 400 (empty), 422 (no speech or too long), 503 |
| `/api/story/import` | PDF ≤ 4 MB, ≤ 30 pages (unpdf) | `{text}` | 415, 413, 400, 422 |

`/api/story/import` and the `draft` step are not called by any current UI.

## Multi-agent Creative Director (`src/lib/agents`, D-018)

| File | Role |
|---|---|
| `types.ts` | Contract: `SpecialistId`, `SPECIALIST_LABELS`, `Recommendation`, `DirectorRequest`, `DirectorResponse` (client-safe types) |
| `router.ts` | `selectSpecialists(message)` — deterministic keyword scoring, no model call. Review wording selects the domains it names (all five if none). Whole scene/shot add/delete/reorder requests and unmatched requests return `[]` → refine fallback |
| `story-analyst.ts`, `cinematography-director.ts`, `sound-director.ts`, `editing-director.ts`, `continuity-reviewer.ts` | One specialist each: role, instructions, `buildContext` (only the plan fields it needs, shot ids like `S01_SH02`), output schema, owned editable fields, `maxOutputTokens` (1,200–1,500) |
| `schemas.ts` | Shared flat output shape `{summary, recommendations[], edits[]}` and the `directorRequest` request schema |
| `merge.ts` | Sanitises edits (owned field, existing scene/shot, valid seconds) and applies them to a `structuredClone` of the plan; same-field clashes resolved by priority Story > Continuity > Cinematography > Editing > Sound and recorded as conflicts |
| `orchestrator.ts` | `runDirector(input, deps)` — selects specialists, runs them in parallel (`Promise.allSettled`, 60 s timeout each), merges edits, synthesises one reply with a single extra call only when ≥2 specialists succeed (≤700 tokens, 30 s), records one usage record per call, throws `DirectorError` if all fail |
| `shared.ts` | Context helpers shared by specialists |

Field ownership: Story → logline, intent, scene title, action · Cinematography → framing, camera · Sound → sound · Editing → seconds · Continuity → location, characters. Call budget per request: ≤5 specialist calls + ≤1 synthesis call, no retries or recursion. `callModel` and `refine` are injected, so the engine is unit-tested with fakes.

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
| `server/refine.ts` | `runRefine` — the general plan-edit call shared by the refine and director routes |
| `server/plan-validation.ts` | `findPlanProblem` — structural plan validation |

## Design system

`:root` tokens in `src/app/globals.css`: `--background #f5f2eb`, `--paper #fffdfa`, `--ink #231d17`, `--muted #62594e`, `--line #d8cfc2`, `--accent #893a26`, `--highlight #fbefe7`, `--bubble-user #efe6d8`; `color-scheme: light`. Body text uses `system-ui`; headings and `.studio-title` use Georgia. No web fonts and no dark mode. Breakpoints at 35, 48 and 60 rem, plus `prefers-reduced-motion`.

## Tests

`npm test` runs `node --import tsx --test test/*.test.ts` (53 tests):

- `formats.test.ts` — default format, enabled list, `formatSchema` accept/reject and message
- `prompts.test.ts` — `composeInstructions` determinism and coverage for every step × format, plan instructions (answers, collected details, original dialogue)
- `interview.test.ts` — `resolveInterviewTurn` (ask, duplicate, cap, default recommendation), schema parsing, short-film interview instructions
- `planning.test.ts` — plan request with `collected` and edited answers, `findPlanProblem`
- `agents.test.ts` — router selection, each specialist's context and schema, parallel execution, synthesis only for ≥2, partial and total failure, merge/conflicts/isolation, refine fallback, usage per call

Not covered: route handlers end to end, `session.ts`, the hooks and the UI. CI does not run the tests.
