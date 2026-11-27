# Story & Shot Planner

These repository instructions adapt ECC 2.2.3's common and TypeScript rules to this Next.js App Router project.

## Development

- Use Node.js 24 and npm. Run `npm ci` to install the versions pinned in `package-lock.json`.
- Run `npm run dev` for local development. For application changes, run `npm run lint`, `npm run typecheck`, and `npm run build`, in that order. These match CI. Biome lints `src`, and the typecheck generates Next.js route types before running TypeScript.
- For changes to the story workflow, verify the affected path from intake through review in the browser. Use synthetic story text and media when testing. Verify error handling and upload limits when changing a route that accepts files.

## Next.js and React

- Keep pages, layouts, and route handlers in `src/app`. Use Server Components by default. Add `"use client"` at the smallest component boundary that needs browser APIs, event handlers, or React state.
- Keep OpenAI calls, credentials, and Node.js-specific helpers in server code. Place reusable server helpers in `src/lib/server` and keep them out of the client import graph. Use the Node.js runtime for handlers that depend on Node.js APIs.
- Preserve existing route response shapes and status codes unless the requested change also updates their callers. Reuse shared request schemas, response types, and input limits in `src/lib`.
- Preserve explicit user actions for AI requests. Keep loading, error, and retry states visible and retain the user's draft if a request fails.

## TypeScript

- Keep strict type checking enabled. Give shared utilities and API contracts clear parameter and return types. Use named types for component props and shared data shapes, and let TypeScript infer straightforward local types.
- Treat request bodies and external responses as `unknown` until validated. Reuse Zod schemas where structured validation is needed and infer types from those schemas. Narrow unknown errors before reading their properties.
- Update React state and shared values immutably. Reuse existing helpers and keep components and functions focused.

## Data and credentials

- Keep `OPENAI_API_KEY` in server-side environment variables. Use placeholders in `.env.example` and keep credentials out of client bundles and logs.
- Enforce shared upload and text limits on the server before processing uploads or calling providers. Return actionable errors without exposing provider internals. Log diagnostic metadata without including story text, uploaded files, or audio.
