# Current status

**Last updated:** 2026-11-27, during Phase 4 (live integration and end-to-end verification). Update this file after every major phase.

Verification levels used below: **live-API** (real OpenAI call observed), **unit-tested** (`npm test`), **code-level** (read in the code, not run), **browser-tested** (driven in a real browser).

## Phases

| Phase | State |
|---|---|
| Phase 1 — format registry, composable prompts | Done |
| Phase 2 — adaptive one-question interview | Done (backend). The Studio UI does not support editing earlier answers — see bugs. |
| Phase 3 — PostgreSQL persistence | Built, then removed at the user's request (D-008) |
| Cleanup audit | Done — legacy UI and dead exports removed |
| Agent workspace (this documentation) | Done |
| Phase 4 — live integration and browser E2E | **In progress** — API verified; browser journey results pending |

## Working

| Capability | Verified by |
|---|---|
| `OPENAI_API_KEY` loads on the server; account can reach both models | live-API (`GET /v1/models` → 200) |
| Adaptive interview turn through `/api/story/plan` returns one question, note, rationale, collected items and usage | live-API (581 tokens, 8.5 s) |
| Request validation and error messages: malformed JSON 400, invalid step/limits 400, unsupported audio 415, empty audio 400, audio > 4 MB 413 | live-API (no model call) |
| Format registry, prompt composition, interview resolver | unit-tested (20/20) |
| New Chat asks only for a title; one question per turn; Generate shot plan; editable Story Editor; Apply/Discard with no silent apply; open/rename/delete sessions with confirm; usage view and token budget; voice transcription path; settings show models and formats | code-level |

## Pending

- Browser testing of the full journey on desktop and mobile (Phase 4 run in progress).
- Live verification of plan generation, refine and voice transcription.

## Known bugs (code-level unless noted; not yet fixed)

1. **Blocker for plans with dialogue.** The Studio sends the project title as `story` (`studio-app.tsx:199` → `generatePlan`). The plan route requires every dialogue line to appear verbatim in `story` (`api/story/plan/route.ts:62-65`), so a plan containing dialogue returns 502. Fixing it needs a decision on where Studio dialogue comes from (affects D-015).
2. **Major — editing earlier interview answers is not implemented** in the Studio, although it is an MVP requirement. The only UI that supported it was in the removed legacy workflow, which was already unreachable.
3. **Major — Apply replaces the whole plan** with the proposal's snapshot, so manual edits made after the proposal was requested, or a newer applied proposal, are overwritten.
4. **Minor** — The composer allows 4,000-character answers, but interview answers are capped at 2,000 (`MAX_ANSWER_CHARACTERS`), so long answers get a 400.
5. **Minor** — Model questions over 500 characters aren't truncated on the server, so the next turn fails validation.
6. **Minor** — Text sent after the interview is complete is saved to the chat but never sent to the model.
7. **Minor** — A disabled format gets the generic 400 message instead of "This filmmaking format isn't available yet." (live-API).
8. **Minor** — Voice error text says "upload audio", but there is no upload UI.
9. **Minor** — The editor lets the project title be emptied.
10. **Cosmetic** — The sidebar's Token usage nav item never shows as active.

Cleanup candidates: about 45 unused CSS selectors in `globals.css`; `/api/story/import` and the `draft` step are unused by the UI; `DiscoveryExchange` duplicates `InterviewExchange`; `onVoiceActive` is a no-op; `useTokenBudget().hydrated` is unused.

## API configuration

- Key: valid as of 2026-11-27 (the earlier 401 is resolved).
- Models: `gpt-6.2-sol` and `gpt-transcribe` verified available. They are the only models the project key can see.
- Secrets: read only on the server; logs carry usage metadata only.

## Testing status

| Check | Result (2026-11-27) |
|---|---|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm test` | Pass — 20/20 (formats, prompts, interview) |
| `npm run build` | Pass |
| Browser E2E | Pending |
| CI | Runs lint, typecheck and build — not `npm test` |

## Repository state

- Three commits (latest d9e51af). Everything since is uncommitted.
- `README.md` still describes the removed intake flow.
- A parallel Claude session also edited this repo on 2026-11-27 — check for concurrent work before editing.

## Next recommended task

Finish Phase 4: collect the browser results, get the user's decision on bug 1, fix the verified defects, re-run all four checks, and update this file.
