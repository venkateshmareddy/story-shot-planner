# Story & Shot Planner

Turn a story idea or finished story into an editable shot-by-shot plan with AI-assisted co-writing, creator approval, and PDF export.

## Local development

Use Node.js 24 with npm. The repository includes `.node-version` for version managers and `package-lock.json` for reproducible installs.

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Story intake works without API credentials.

## OpenAI setup

Copy `.env.example` to `.env` if needed. Set `OPENAI_API_KEY` to the team-issued key and restart the dev server. Git ignores `.env`. On Vercel, set the same variable in the project's environment settings. Use a protected deployment when sharing the app with the team, since visitors with access can make requests billed to the team's key.

| Feature | Model |
| --- | --- |
| Story draft, intent interview, and shot planning | `gpt-6.2-sol` |
| Voice note transcription | `gpt-transcribe` |

The server uses the Responses and Audio Transcriptions APIs. Each model request starts from an explicit action. The server logs provider usage metadata when available and the SDK makes no automatic retries.

## Implemented

- Both **Start with an idea** and **Use a finished story** accept typed text, UTF-8 TXT files, and PDFs with selectable text.
- Review and correct extracted text in the editor. PDF extraction runs on the app server and uses no OpenAI credits. Complex layouts can affect reading order. For image-only scans or password-protected PDFs, paste the text or upload a readable copy.
- TXT uploads are limited to 5 MB, PDFs to 4 MB and 30 pages, and story text to 60,000 characters. The PDF limit leaves room under Vercel Functions' default request limit. Typed and TXT input stay in the browser. PDF bytes are sent to the application server for extraction. This scaffold keeps the draft in the current page session.
- Choose **Review story** to develop an idea or start the intent interview for a finished story. Confirm intent to generate a shot draft.
- Under **Voice note**, record with the browser microphone or upload an audio file up to 4 MB. Recording requires microphone permission on localhost or HTTPS. You can play the clip back before selecting **Transcribe voice note** to send it for transcription and fill the editor.
- Durable storage, shot editing, plan approval, PDF export, and cost reporting are planned.

## Project layout

- `src/app` contains the App Router pages and intake UI.
- `src/app/api/story/import/route.ts` handles bounded PDF uploads and text extraction.
- `src/app/api/story/plan/route.ts` and `src/app/api/story/transcribe/route.ts` handle authenticated provider calls from the server.
- `src/lib/story-input.ts` defines the shared intake limits and response types.
- `.github/workflows/checks.yml` runs lint, type checking, and a production build on pull requests and pushes to `main`.

Run the same checks locally with `npm run lint`, `npm run typecheck`, and `npm run build`.
