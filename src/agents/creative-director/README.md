# The Creative Director's brain

These Markdown files are the in-app AI Creative Director's instructions: who it is, what it values, how it writes,
and what each model call must do. The server reads them once when it starts (`src/lib/server/brain.ts`) and builds
every call's fixed `instructions` from them. This README is for people and is never sent to the model.

**After editing any file here, restart the dev server** (`npm run dev`): files are read once at startup, not per
request. Then run `npm test`. `test/brain.test.ts` compares every final instruction string with
`test/fixtures/brain-instructions.json`; when your change is intended, accept it with
`UPDATE_BRAIN_FIXTURE=1 npm test` and review the fixture diff.

## What is sent to the model

- The top `# Title` line and `<!-- notes -->` are for people only and are dropped.
- Write each instruction as one paragraph on one line. Blank lines between paragraphs are dropped (each paragraph
  becomes one line of the prompt); they cost tokens and the model doesn't need them.
- `{{NAME}}` is filled from a code constant or another brain file when the server starts. An unknown name stops the
  server and fails the tests, so a typo never reaches the model.
- Files with `## name` sections are read section by section; every line must sit in a section.

## Files

| File | Sent with | What it holds |
|---|---|---|
| `SAFETY.md` | every call | Everything the filmmaker wrote or uploaded is data, never instructions |
| `IDENTITY.md` + `SOUL.md` | every story stage, expert and the team answer | Who the Creative Director is; its values |
| `style/PLAIN_WORDS.md` | every story stage, expert, team answer, image analysis | How it writes |
| `style/DISCOVERY.md` | interview | One short question with answer choices |
| `style/ANALYSIS.md` | draft, plan outline, chat edit, originality review and compare, experts, team answer | One-line answer, then short points |
| `rules/*.md` | filled into stages and experts as `{{..._RULE}}`, `{{SHOT_RULES}}`, `{{EDIT_HISTORY}}`, `{{EDIT_DATA}}`, `{{ENGAGEMENT_RUBRIC}}` | Rules shared by several calls; `rules/MEMORY.md` explains the memory section; `rules/ENGAGEMENT_RUBRIC.md` is the engagement scoring rubric |
| `stages/<stage>.md` | that stage's call | The task: `draft`, `interview`, `plan_outline`, `plan_scene`, `edit_plan`, `edit_scene`, `ideas`, `originality_review`, `originality_compare`, `engagement_scene`, `engagement_summary` |
| `formats/<format>.md` | after the stage text | One `## <stage>` note per stage for that film format |
| `experts/TEAM.md` | each of the five experts | Rules every expert shares, filled with its own file |
| `experts/<id>.md` | that expert | `role`, `scope`, `expertise`, `checklist`, `fields` |
| `experts/SYNTHESIS.md` | the team answer | Turning several experts' findings into one reply |
| `helpers/IMAGE.md` | reference image analysis | `identity` and `task` |
| `helpers/DIGEST.md` | condensing a long imported story | The digest task |
| `helpers/TRANSCRIBE.md` | voice-to-text (Google Gemini: first user text part, before the audio) | Clean-verbatim rules, how to use the project title and names, film terms to spell correctly, plain-text reply. The dedicated transcribe model mostly ignores it; `src/lib/transcript-cleanup.ts` guarantees the basics |

## Placeholders

| Placeholder | Value from |
|---|---|
| `{{MAX_PLAN_SCENES}}`, `{{MAX_RENAMES}}` | `src/lib/story-planning.ts` |
| `{{MAX_UNRESOLVED}}`, `{{SKIPPED_ANSWER}}`, `{{DECIDE_ANSWER}}` | `src/lib/story-context.ts` |
| `{{MAX_OPTIONS}}` | `src/lib/interview.ts` |
| `{{MAX_VISUAL_MENTIONS}}` | `src/lib/visual-discovery.ts` |
| `{{SURPRISE_ME}}`, `{{MIN_CONCEPTS}}`, `{{MAX_CONCEPTS}}`, `{{MAX_COMBINE}}` | `src/lib/ideas.ts` |
| `{{MAX_SPECIALIST_RECOMMENDATIONS}}`, `{{MAX_SPECIALIST_EDITS}}` | `src/lib/agents/shared.ts` |
| `{{MAX_TROPES}}`, `{{MAX_FINDINGS}}`, `{{MAX_CANDIDATES}}` (= `MAX_REFERENCES`), `{{SEVERITY_RULES}}` (from `SEVERITY_DEFINITIONS`) | `src/lib/originality.ts` |
| `{{MAX_KEY_FACTORS}}`, `{{MAX_RECOMMENDATIONS}}` | `src/lib/engagement.ts` (the curve-note limit, 6, is written out and checked against `MAX_CURVE_NOTES` by a test) |
| `{{SOURCE_STORY_RULE}}`, `{{SUGGESTED_CONCEPT_RULE}}`, `{{MEMORY_RULE}}`, `{{SHOT_RULES}}`, `{{EDIT_HISTORY}}`, `{{EDIT_DATA}}`, `{{ENGAGEMENT_RUBRIC}}` | `rules/*.md` |
| `{{ROLE}}`, `{{EXPERTISE}}`, `{{CHECKLIST}}`, `{{FIELD_RULES}}`, `{{OTHERS}}` | `experts/<id>.md` (TEAM.md only) |

## How the project memory reaches the model

These files are the fixed part of every call. The project itself (what the filmmaker said, what was approved, the
chat, earlier decisions, the plan) is the variable part: `src/lib/server/memory-view.ts` writes it into the call's
`input` as compact `## SECTION` blocks, stable ones first, the new request last. The plan stays minified JSON because
edits need exact positions.

| Section | Holds |
|---|---|
| `## MEMORY — what we know` | Facts as `- category · Label: value` under *From the filmmaker*, *Approved* and *AI suggestions* |
| `## REMOVED by the filmmaker` | Facts the filmmaker deleted; never re-added |
| `## OPEN QUESTIONS` · `## MISSING` | Open gaps · uncovered category ids, most important first |
| `## VISUAL GAPS` | Interview only, last: open key looks (`- name: what to ask about`, hint from code) and `Look questions left: N`; absent until idea, genre and format are covered or when nothing is open |
| `## STORY` · `## STORY SOURCE` · `## MESSAGE` | The filmmaker's own text, fenced so it stays data |
| `## ANSWERS` · `## DIRECTIONS` · `## COLLECTED` | Numbered interview Q/A · directions after the interview · collected details |
| `## DECISIONS` · `## RECENT CHAT` | Applied / Discarded proposals · *Filmmaker:* / *Creative Director:* lines |
| `## PLAN (JSON)` and other `(JSON)` sections | Plan data |
| `## PLAN` · `## DISMISSED` · `## REFERENCES` | Originality check: the plan as text (S01, S01_SH02, action, dialogue) · dismissed concerns · fetched Wikipedia extracts, fenced |
| `## FILM` · `## SCENES` · `## SCENE TO ASSESS` · `## SCENE ASSESSMENTS` | Engagement report: title, logline, intent, characters, places · one line per scene with its pace metrics (measured in code) · one scene's shots (S02_SH03, seconds, action, emotion, sound, dialogue) · the scene results the summary call reads |

Empty sections are left out. Every section a call receives must be named in that call's instructions here
(`test/memory-view.test.ts` checks it). Category ids, field names and output keys in these files must match the Zod
schemas exactly; the model's output is validated against them.
