# Token efficiency

- Launch only the agents that materially help. No agent for a lookup or a small edit; never two agents on the same question.
- Brief each agent with only the files and facts it needs. Reuse what's already in `project-agent/` instead of re-auditing the repo.
- Prefer deterministic TypeScript/Zod logic over model calls for validation, routing and formatting.
- In the app: one model call per user action, bounded `max_output_tokens`, no retry loops.
- Read only what you need (line ranges, grep). Don't paste whole files, logs or HTML into context. Make test scripts print compact PASS/FAIL lines. Don't read full-page screenshots.
- Debugging: reproduce once, then instrument. At most two attempts per failure before reporting it.
- Stop when the acceptance criteria are met. Report concisely: files changed, validation results, blockers.
- Keep always-loaded memory short (`CLAUDE.md`, `.claude/rules/`). Put detail in `project-agent/` and read it on demand.
- Never trade correctness, security, tests or maintainability for fewer tokens.
