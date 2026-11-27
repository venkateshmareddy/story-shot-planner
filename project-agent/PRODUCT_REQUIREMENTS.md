# Product requirements — AI Creative Studio

**Status labels.** MVP = required for the hackathon MVP. Direction = approved product direction that is *not* in the MVP — don't build it without the user's approval. Out = explicitly excluded.

## Product

A chat-first AI creative director for filmmaking. Through conversation it develops a filmmaker's idea into a text filmmaking blueprint — story, characters, locations, scenes and a shot breakdown — analysing and challenging choices while the filmmaker keeps final control. English first.

## MVP requirements (confirmed)

1. **Chat-first studio.** The conversation is the primary interface.
2. **New Chat asks only for the project title**, then starts the AI conversation. No other onboarding questions or forms.
3. **Left sidebar** with session history: open, rename, and delete (with confirmation), plus New Chat.
4. **Conversation panel** (left of the workspace): the AI asks one adaptive question at a time; the filmmaker answers by text or voice and can revise earlier answers.
5. **Editable Story Editor** (right): characters, locations, scenes and shots, editable by hand.
6. **AI proposals require explicit approval.** Every AI refinement is shown as a proposal with Apply or Discard. Nothing changes the story document silently.
7. **Settings and token usage**: the models in use, usage totals, and a token budget.
8. **Short-film workflow only** (`short_film` format) for the MVP.
9. **Cinematography, sound and editing intelligence.** Shots carry framing, camera movement, duration, sound and emotion, and the AI applies craft knowledge from story, character, directing, cinematography, composition, lighting, editing, sound and continuity.
10. **Sessions persist in the browser** (localStorage) and restore on reload.

## AI behaviour rules (MVP)

- Ask exactly one question per turn. Analyse the latest answer first; never re-ask what the story or earlier answers already settle.
- Look for gaps, contradictions, unclear motivation and weak story elements, and explain briefly why a question matters.
- Challenge choices constructively — be friendly, imaginative and honest. The filmmaker has the final say.
- When the filmmaker says "you decide", make one confident creative choice.
- Recognise when enough is known and recommend moving to planning.
- When planning from an approved story, never invent speaking characters, events or dialogue; dialogue is copied verbatim from the story.
- Never silently replace an approved creative decision — propose, explain, and wait for Apply.

## Approved direction — not in the MVP (needs approval before building)

- Additional formats: feature film, web series, documentary, advertisement, music video. They are registered in the format registry but disabled.
- Uploading documents and images as inputs; analysing images for composition, angle, lighting, colour, environment, character placement and mood (analysis only).
- Per-project creative decision history and memory; filmmaker preferences that carry across projects.
- Revision and approval history.
- Export of one complete, editable filmmaking document (PDF or DOCX), with confirmation before the final approved export.
- Durable server-side persistence.

## Out of scope

- Image, storyboard, animation, video or audio generation.
- Production budget estimation.
- Authentication, multi-user accounts and team collaboration (MVP).
- Any feature not listed above unless the user approves it.
