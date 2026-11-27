# Story & Shot Planner

Turn a story idea or finished story into an editable shot-by-shot plan with AI-assisted co-writing, creator approval, and PDF export.

## Local development

Use Node.js 24 with npm. The repository includes `.node-version` for version managers and `package-lock.json` for reproducible installs.

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Story intake works without API credentials.

## Implemented in the scaffold

- Both **Start with an idea** and **Use a finished story** accept typed text, UTF-8 TXT files, and PDFs with selectable text.
- Review and correct extracted text in the editor. PDF extraction runs on the app server and uses no OpenAI credits. Complex layouts can affect reading order. For image-only scans or password-protected PDFs, paste the text or upload a readable copy.
- TXT uploads are limited to 5 MB, PDFs to 4 MB and 30 pages, and story text to 60,000 characters. The PDF limit leaves room under Vercel Functions' default request limit. Typed and TXT input stay in the browser. PDF bytes are sent to the application server for extraction. This scaffold keeps the draft in the current page session.
- Co-writing, the intent interview, durable storage, shot generation and editing, approval, export, and cost accounting are planned for later implementation.

## Project layout

- `src/app` contains the App Router pages and intake UI.
- `src/app/api/story/import/route.ts` handles bounded PDF uploads and text extraction.
- `src/lib/story-input.ts` defines the shared intake limits and response types.
- `.github/workflows/checks.yml` runs lint, type checking, and a production build on pull requests and pushes to `main`.

Run the same checks locally with `npm run lint`, `npm run typecheck`, and `npm run build`.
