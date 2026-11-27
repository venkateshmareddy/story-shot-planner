# AI Creative Studio

Chat-first AI creative director for filmmakers — a hackathon MVP. The repo/package is named `story-shot-planner`. Next.js 16 App Router + TypeScript + OpenAI SDK + Zod. Short-film workflow only.

Team coding rules (Next.js, React, TypeScript, credentials) — imported here because Claude Code stops reading AGENTS.md on its own once a CLAUDE.md exists:

@AGENTS.md

## Before you implement anything

1. Read `project-agent/CURRENT_STATUS.md` — the latest verified state.
2. Read the docs relevant to your task. They are **not** auto-loaded:

| File | Read when |
|---|---|
| `project-agent/SOUL.md` | Starting any work — how this team behaves |
| `project-agent/PRODUCT_REQUIREMENTS.md` | Touching product behaviour or UI |
| `project-agent/ARCHITECTURE.md` | Touching code — components, routes, data flow |
| `project-agent/TECH_STACK.md` | Dependencies, versions, commands, config |
| `project-agent/DECISIONS.md` | Before proposing any architectural or product change |
| `project-agent/DEVELOPMENT_ROADMAP.md` | Choosing what to work on next |
| `project-agent/PROJECT_MEMORY.md` | Long-term context, past phase outcomes, gotchas |

3. Verify against the code. Docs can lag; the code is the source of truth. If they disagree, say so and fix the doc.

## Non-negotiables

- Don't invent architecture, features or completed work. State how anything was verified: code-level, unit-tested, browser-tested or live-API-tested.
- Preserve: localStorage session persistence, `short_film` as the only enabled format, the adaptive one-question interview, the chat + editable Story Editor UI, explicit Apply/Discard for every AI proposal, token usage tracking, and the warm cream/terracotta theme.
- No PostgreSQL/Prisma, authentication, multi-user, RAG, extra formats, image/video/audio generation or budget estimation unless the user approves it (see `project-agent/DECISIONS.md`).
- Never print, log, commit or request API keys or secrets. Don't change model IDs without verifying them against the account.
- Commit only when the user asks.

## Agents and rules

- `.claude/rules/` loads automatically: `coding-standards.md` (includes organization Rule 27), `agent-coordination.md`, `token-efficiency.md`.
- Specialist subagents in `.claude/agents/`: `frontend-specialist`, `backend-specialist`, `ai-engineer`, `testing-specialist`, `project-reviewer`.
- The main session is the orchestrator: it assigns file ownership, owns shared files, integrates results and runs final validation.

## Validation

`npm run lint` · `npm run typecheck` · `npm test` · `npm run build`. Run what's relevant after a change and all four at the end of a phase. Don't run `npm run build` while a browser test is using the dev server.

## Keeping the docs current

After a phase or significant change, the orchestrator updates `project-agent/CURRENT_STATUS.md`. Any new, changed or reversed decision goes in `project-agent/DECISIONS.md` with its date and reason.
