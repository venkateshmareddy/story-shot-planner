# Decisions

Confirmed architectural and product decisions. Add new ones at the end with the date and reason. To reverse one, add a new entry that supersedes it — don't delete history.

| ID | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-001 | 2026-11-27 | Stack: Next.js 16 App Router, TypeScript (strict), OpenAI SDK, Zod. | Existing scaffold (commits c4f4d8e, d9e51af). | Active |
| D-002 | 2026-11-27 | Build a hackathon MVP, not enterprise infrastructure. Organization Rule 27 (enterprise-grade engineering) still governs code quality and design; deferred infrastructure is a recorded exception with an upgrade path. | User's hackathon scope vs. the organization's non-negotiable rule — reconciled in `.claude/rules/coding-standards.md`. | Active — reconciliation awaiting user confirmation |
| D-003 | 2026-11-27 | Format registry (`src/lib/formats.ts`) with six formats registered and only `short_film` enabled. New formats are added as configuration. | MVP is short film; the architecture must not need a rewrite for other formats. | Active (Phase 1) |
| D-004 | 2026-11-27 | Prompts are composed: `SOURCE_RULES` + `CRAFT_PRINCIPLES` + stage base + per-format modifier (`composeInstructions`). | Reuse filmmaking knowledge across formats without duplicating prompt text. | Active (Phase 1) |
| D-005 | 2026-11-27 | `format` is optional on requests and defaults to `short_film` on the server; disabled or unknown formats are rejected. | Backward compatibility with existing clients. | Active (Phase 1) |
| D-006 | 2026-11-27 | Adaptive one-question-at-a-time interview. The model returns a flat schema; the pure `resolveInterviewTurn` forces completion on a duplicate or empty question, a model "complete", or 12 answered turns. | Real creative-director conversation instead of a batch questionnaire; deterministic, testable guards. | Active (Phase 2) |
| D-007 | 2026-11-27 | Every AI refinement is a proposal that needs explicit Apply or Discard; nothing overwrites the story silently. | Filmmaker keeps final creative control. | Active |
| D-008 | 2026-11-27 | Session persistence is browser `localStorage` behind `useSessions()`. A PostgreSQL + Prisma implementation was built in Phase 3 and then removed at the user's request. | Hackathon scope. `useSessions()`'s `SessionStore` interface is the seam for a future database. Supersedes the Phase 3 database decision. | Active |
| D-009 | 2026-11-27 | No authentication or multi-user support in the MVP. | Hackathon scope. | Active |
| D-010 | 2026-11-27 | Tests use the built-in `node:test` runner with no extra dependencies. `tsx` was added for Phase 3 and removed with it. | Zero-dependency testing; mocked model output so tests need no API key. | Active |
| D-011 | 2026-11-27 | Models: `gpt-6.2-sol` for story work, `gpt-transcribe` for voice. Change only after verifying against the account. | Both verified available via `GET /v1/models`. | Active |
| D-012 | 2026-11-27 | UI is the Studio: session sidebar, conversation panel and editable Story Editor, plus settings and usage views, in the warm cream/terracotta theme. The earlier intake → workflow → studio components were removed. | Confirmed interface; the legacy components were unreferenced after the Studio replaced them. | Active |
| D-013 | 2026-11-27 | Token usage is recorded only from the real `response.usage`; one model call per user action. | Accurate cost tracking; never fabricate usage. | Active |
| D-014 | 2026-11-27 | Outputs are text only: no image, storyboard, animation, video or audio generation, and no budget estimation. | Product scope. | Active |
| D-015 | 2026-11-27 | The plan step enforces that every dialogue line appears verbatim in the source story; refine does not, because the filmmaker is directing the edit. | Prevent invented dialogue while allowing user-directed rewrites. | Active |
| D-016 | 2026-11-27 | Project agent workspace: root `CLAUDE.md` (imports `AGENTS.md`), auto-loaded `.claude/rules/`, specialist subagents in `.claude/agents/`, on-demand knowledge in `project-agent/`. | Consistent rules and continuity across sessions with small always-loaded context. | Active |
