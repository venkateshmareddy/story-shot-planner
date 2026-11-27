# Tech stack

Versions are the ones `package-lock.json` installs, checked on 2026-11-27. Update this file whenever dependencies change.

## Runtime and framework

| | Version | Notes |
|---|---|---|
| Node.js | 24.x | `engines` and `.node-version` (24); local 24.15.0 with npm 11.12.1 |
| Next.js | 16.4.6 | App Router. `next.config.mjs` sets the Turbopack root. Route handlers use the Node runtime. |
| React / React DOM | 19.3.1 | |
| TypeScript | 5.9.3 | `strict`, `moduleResolution: bundler`, `jsx: react-jsx`, alias `@/*` → `./src/*` |

## Libraries

| Package | Version | Used for |
|---|---|---|
| openai | 7.65.0 | Responses API (`responses.parse` + `zodTextFormat` structured outputs) and audio transcription — server only, via `src/lib/server/openai.ts` |
| zod | 4.6.7 | Request and response validation, structured-output schemas |
| unpdf | 2.2.3 | PDF text extraction in `/api/story/import` |

## Dev tooling

| Tool | Version | Used for |
|---|---|---|
| @biomejs/biome | 2.6.9 | `biome lint src` with default rules (no `biome.json`) |
| typescript | 5.9.3 | `tsc --noEmit` after `next typegen` |
| @types/node / @types/react / @types/react-dom | 24.19.4 / 19.3.3 / 19.3.0 | |
| Test runner | Node built-in `node:test` | Run through `tsx` |
| tsx | 4.23.15 (dev only) | Resolves `@/` and relative imports for `npm test` (D-019) |

## AI models

Verified available on the account on 2026-11-27 with `GET /v1/models` (HTTP 200). The project key can see only these two models. Defined in `src/lib/models.ts`.

- `gpt-6.2-sol` — `STORY_MODEL`: interview, plan, draft and refine
- `gpt-transcribe` — `TRANSCRIPTION_MODEL`: voice notes

## Configuration

- `.env` (git-ignored): `OPENAI_API_KEY`, read only on the server. `.env.example` holds the placeholder.
- Persistence: browser `localStorage`. There is no database.
- Deploy target: Vercel (per README). Set `OPENAI_API_KEY` in the Vercel project's environment settings.
- CI: `.github/workflows/checks.yml` runs `npm ci`, lint, typecheck and build on pull requests and pushes to `main`. It does **not** run `npm test` yet.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install the exact locked versions |
| `npm run dev` | Dev server on http://localhost:3000 |
| `npm run lint` | Biome lint of `src` |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm test` | `node --import tsx --test test/*.test.ts` |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
