# Agent coordination

- The main session is the **orchestrator**. It plans, assigns work, owns shared files, integrates results and runs the final validation. Specialist agents don't spawn further agents.
- Use parallel agents only for genuinely independent work. A lookup or a change to a few files is done directly, without an agent.
- Before dispatching parallel agents, lock the shared contracts (schemas, types, API shapes) so every agent builds against the same interface.
- Every assignment names the files the agent owns. Two agents never edit the same file in the same phase.

## File ownership

**Shared — orchestrator only.** A specialist edits one of these only when explicitly assigned for that task: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.mjs`, `.github/**`, `.env.example`, `src/app/globals.css`, `src/lib/session.ts`, `src/lib/story-planning.ts`, `CLAUDE.md`, `AGENTS.md`, `.claude/**`, `project-agent/**`.

| Agent | Owns by default |
|---|---|
| frontend-specialist | `src/app/**/*.tsx` (not `src/app/api/**`), `src/lib/use-sessions.ts`, `src/lib/use-token-budget.ts` |
| backend-specialist | `src/app/api/**`, `src/lib/server/openai.ts`, `src/lib/server/read-body.ts`, `src/lib/story-input.ts`, `src/lib/usage.ts` |
| ai-engineer | `src/lib/server/prompts.ts`, `src/lib/formats.ts`, `src/lib/interview.ts`, `src/lib/models.ts`, `src/lib/studio-agent.ts` |
| testing-specialist | `test/**`, plus throwaway E2E harnesses in a scratch directory outside the repo |
| project-reviewer | Nothing — read-only |

- A specialist that finds a defect outside its files reports it (file, line, repro, severity). It doesn't fix it.

## Working safely

- Check for concurrent work before editing: `git status`, recent file modification times, and other Claude sessions working in this repo. If someone else is editing a file, don't touch it — tell the user.
- Every agent reads `project-agent/CURRENT_STATUS.md` and the docs relevant to its task before starting.
- Agents report in the format their definition specifies: summary, files by subsystem, exact validation results, verification level, findings, blockers, proposed doc updates.
- The orchestrator waits for every assigned agent, re-runs validation itself, checks agent claims before repeating them, and returns one consolidated report.
- After a phase, the orchestrator updates `project-agent/CURRENT_STATUS.md` and records decisions in `project-agent/DECISIONS.md`.
