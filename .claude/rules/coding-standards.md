# Coding standards

Baseline: `AGENTS.md` (imported by `CLAUDE.md`). This file adds the project-wide rules.

## Rule 27 — enterprise-grade engineering (organization rule, non-negotiable)

All code and architecture must be production-grade and designed so the system can grow to millions of users without a rewrite.

- Validate every external input with Zod. Treat request bodies and model output as `unknown` until parsed.
- Keep server/client separation strict. Secrets live only on the server — never in client bundles or logs.
- Handle errors explicitly with actionable messages that don't leak internals. Keep the user's draft when a request fails.
- Keep clean seams so infrastructure can be swapped later: session persistence only through `useSessions()`, AI calls only through `src/lib/studio-agent.ts` → `/api/story/*`, formats only through the registry in `src/lib/formats.ts`.
- No shortcuts that block scaling: no mutable server state, no unbounded inputs, no N model calls where one will do.

**Hackathon reconciliation.** The user has deferred infrastructure scale-out (database, auth, job queues, rate limiting) for the MVP — `project-agent/DECISIONS.md` D-002 and D-008. That is a recorded exception, not permission to lower code quality. Any new infrastructure-level choice must either meet Rule 27 or be approved by the user as a hackathon exception and recorded in DECISIONS.md.

## Project rules

- TypeScript strict. Infer types from Zod schemas. Reuse the shared schemas and limits in `src/lib` instead of redefining them.
- One model call per user action, with a bounded `max_output_tokens`. Record usage only from the real `response.usage`.
- Keep the design tokens on `:root` in `src/app/globals.css` (warm cream / terracotta). Don't restyle or add themes unless asked.
- No new dependencies without a stated reason. Prefer the platform (`node:test`, Web APIs).
- No comments by default — one short line only for a non-obvious why.
- Preserve working behaviour. Never change behaviour just to make a test pass.
- Tests use `node:test` in `test/`. Any module a test imports must resolve under plain Node: package imports or type-only `@/` imports only (see `project-agent/PROJECT_MEMORY.md`).

## Before you finish

Run what's relevant — `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` — and report the exact results. Never say something works without saying how it was verified.
