# Project memory

Long-term knowledge that isn't obvious from the code. Keep entries short and dated. Decisions themselves live in `DECISIONS.md`.

## Product vision

A movie-focused AI creative director — not a generic story generator. Chat-first: it explores the filmmaker's intent one question at a time, then produces an editable text filmmaking blueprint (story, characters, locations, scenes, shots). It analyses, challenges and suggests; the filmmaker approves. Short film is the MVP; feature film, web series, documentary, advertisement and music video are future format profiles.

## Hackathon objectives

- A working end-to-end demo: New Chat → adaptive interview → shot plan → editable Story Editor → refinements with Apply/Discard → reopen the session later.
- Real AI responses and visible token usage.
- A clean, defensible architecture that can grow (organization Rule 27) without enterprise infrastructure yet.

## Phase outcomes (2026-11-27)

- **Phase 1** — Format registry and composable prompts. Only `short_film` is enabled. 10 unit tests.
- **Phase 2** — Adaptive interview replaced the batch questionnaire. 10 more unit tests (20 total).
- **Phase 3** — PostgreSQL + Prisma persistence with 13 persistence tests; all of it removed the same day when the user chose to stay on localStorage for the hackathon.
- **Cleanup** — The Studio UI (built in a parallel session) replaced the old intake/workflow/studio flow; four orphaned components and six dead exports removed.
- **Phase 4** — In progress. See `CURRENT_STATUS.md`.

## Known blockers and risks

- Everything after commit d9e51af is uncommitted — one bad checkout loses it.
- Two Claude sessions edited this repo at the same time on 2026-11-27 and clashed on shared files. Check `git status`, recent modification times and other sessions before editing.
- CI doesn't run `npm test`.

## Gotchas

- **Test imports.** `node --test` runs `.ts` natively but can't resolve the `@/` alias or extensionless relative imports at runtime. A module a test imports may use only package imports or type-only `@/` imports. That's why `interview.ts` and `formats.ts` import only `zod`.
- **Structured outputs.** Avoid a union at the root of a `zodTextFormat` schema. The interview turn uses one flat object with a `complete` boolean.
- **Verbatim dialogue.** The plan route rejects a plan whose dialogue isn't copied verbatim from the story. The plan prompt's directive and this validator must stay aligned (covered by `test/prompts.test.ts`).
- **Next.js 16.** Dynamic route params are a `Promise` and must be awaited.
- **Dev server vs build.** Don't run `npm run build` while a browser test is using `next dev`.
- **API key.** It's a project key that can see only `gpt-6.2-sol` and `gpt-transcribe`. A 401 hides whether a model exists — fix the key first, then check models.
- **Secrets.** Check keys by HTTP status and model list only; never print any part of a key.
- **The Studio has no story text.** The project title is sent as `story` to the interview and plan steps. Anything that validates against `story` (the verbatim-dialogue check) sees only the title.
- **Editing earlier answers** existed only in the removed legacy workflow UI. The Studio never implemented it.

## Constraints

- localStorage persistence, no database or auth (D-008, D-009).
- `short_film` only (D-003).
- Text output only; no budget estimation (D-014).
- No new dependencies without a stated reason.
