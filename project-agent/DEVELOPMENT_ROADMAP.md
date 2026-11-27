# Development roadmap

Last updated 2026-11-27. Status details live in `CURRENT_STATUS.md`; decisions in `DECISIONS.md`.

## Completed

| When | Work | Notes |
|---|---|---|
| 2026-11-27 | Scaffold with story intake, PDF/TXT import | Commit c4f4d8e |
| 2026-11-27 | OpenAI integration: draft, interview and plan; voice transcription | Commit d9e51af |
| 2026-11-27 | Model and token usage returned by every AI route | Uncommitted |
| 2026-11-27 | Refine endpoint with Apply/Discard proposals | Uncommitted |
| 2026-11-27 | **Phase 1** — format registry, composable prompts, format-aware requests, tests | Uncommitted |
| 2026-11-27 | **Phase 2** — adaptive one-question interview with deterministic guards, tests | Uncommitted |
| 2026-11-27 | Studio UI — sidebar, conversation panel, Story Editor, settings, usage, token budget, localStorage sessions | Built in a parallel session; uncommitted |
| 2026-11-27 | **Phase 3** — PostgreSQL persistence | Built, then removed at the user's request (D-008) |
| 2026-11-27 | Cleanup audit — legacy UI and dead exports removed | Uncommitted |
| 2026-11-27 | Project agent workspace (this documentation) | Uncommitted |
| In progress | **Phase 4** — live integration and browser E2E | Key and models verified; see `CURRENT_STATUS.md` |

## Current priorities

- **P0** — Finish Phase 4: complete the browser journey, fix verified defects, re-run all validation.
- **P0** — Commit the work. Everything since d9e51af is uncommitted.
- **P1** — Add `npm test` to CI (`.github/workflows/checks.yml`).
- **P1** — Decide on `/api/story/import` and the `draft` step: wire them into the Studio or remove them.
- **P1** — Cap interview question length on the server (a question over 500 characters fails the next turn's validation).
- **P1** — Remove legacy CSS selectors left in `globals.css`.
- **P2** — Update `README.md`, which still describes the old intake flow.
- **P2** — UI tests for the Studio.
- **P3** — A sample session to show judges.

## Deferred — post-hackathon or needs approval

Order follows the AI Creative Director implementation plan.

1. Durable server persistence and creative decision history (database behind the `useSessions()` seam)
2. Revision and approval history
3. Event-driven specialist orchestration
4. Compact per-project memory and rights-aware retrieval (RAG)
5. Complete creative review
6. PDF/DOCX export of the filmmaking document
7. Document and image upload with image analysis
8. A second filmmaking format, to prove extensibility
9. Infrastructure at Rule 27 scale: authentication, async jobs for long model calls, rate limiting and per-user token quotas
