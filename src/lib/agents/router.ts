import { SPECIALIST_IDS, type SpecialistId } from "./types";

const STRONG_TERMS: Record<SpecialistId, readonly string[]> = {
  "story-analyst": [
    "stor(?:y|ies)", "storylines?", "plots?", "arcs?", "motivat\\w*", "conflicts?", "stakes", "structur\\w*",
    "characters?", "characteri[sz]ation", "themes?", "thematic", "loglines?", "intent", "premise",
    "protagonists?", "antagonists?", "narrative", "climax", "subtext", "backstory", "ending", "tension",
  ],
  "cinematography-director": [
    "cameras?", "camerawork", "angles?", "lens(?:es|ing)?", "fram(?:e|es|ed|ing)", "composition\\w*",
    "compos(?:e|ed|ing)", "light(?:s|ing)?", "lit", "close-?ups?", "wide(?:r)?", "medium shots?", "establishing",
    "dolly", "pans?", "panning", "tilt\\w*", "tracking", "handheld", "steadicam", "crane", "zoom\\w*", "focus",
    "depth of field", "pov", "over[- ]the[- ]shoulder", "cinematograph\\w*", "visuals?", "visually",
    "colou?r grad\\w*", "palette", "shot (?:types?|sizes?)", "coverage", "blocking", "aerial", "silhouette\\w*",
    "shadows?", "low[- ]angle", "high[- ]angle", "dutch", "push[- ]in",
  ],
  "sound-director": [
    "sound\\w*", "audio", "music\\w*", "score", "scoring", "soundtrack", "foley", "ambien\\w*", "silen\\w*",
    "voices?", "voice-?overs?", "sfx", "noise\\w*", "quiet\\w*", "loud\\w*", "whisper\\w*", "diegetic",
    "non-diegetic", "room tone", "songs?",
  ],
  "editing-director": [
    "edit(?:s|ed|ing|or)?", "cuts?", "cutting", "transitions?", "pac(?:e|ed|ing)", "rhythm\\w*", "sequenc\\w*",
    "montage\\w*", "tempo", "durations?", "runtime", "timing", "seconds", "drag(?:s|ging|gy)?", "trim\\w*",
    "tighten\\w*", "faster", "slower", "shorter", "longer", "shorten\\w*", "lengthen\\w*", "dissolves?",
    "fades?", "intercut\\w*", "cross-?cut\\w*", "smash cut",
  ],
  "continuity-reviewer": [
    "continuity", "consisten\\w*", "inconsisten\\w*", "contradict\\w*", "props?", "costumes?", "wardrobe",
    "timelines?", "mismatch\\w*", "plot holes?", "locations?", "geography", "eyelines?", "screen direction",
    "180[- ]degree", "time of day", "makeup", "errors?", "mistakes?",
  ],
};

// Half-weight: too generic to route on alone ("shot 3" is a reference, not a cinematography request).
const WEAK_TERMS: Partial<Record<SpecialistId, readonly string[]>> = {
  "cinematography-director": ["shots?"],
  "story-analyst": ["beats?"],
};

const toPattern = (terms: readonly string[]) => new RegExp(`\\b(?:${terms.join("|")})\\b`, "g");

const PATTERNS: Readonly<Record<SpecialistId, { strong: RegExp; weak: RegExp | null }>> = Object.freeze(
  Object.fromEntries(
    SPECIALIST_IDS.map((id) => {
      const weak = WEAK_TERMS[id];
      return [id, { strong: toPattern(STRONG_TERMS[id]), weak: weak ? toPattern(weak) : null }];
    }),
  ) as Record<SpecialistId, { strong: RegExp; weak: RegExp | null }>,
);

const REVIEW_INTENT =
  /\b(?:review|feedback|critique|critici[sz]e|analy[sz]e|analysis|assess(?:ment)?|evaluate|evaluation|give me (?:some )?notes|your notes|what do you think|thoughts on|how (?:can|could|should|would) (?:i|we) improve|improve (?:the|my|this|our) (?:film|movie|short|scene|plan|story|script))\b/;

// Adding/removing/reordering whole scenes or shots is a structural edit for the general refine path.
const STRUCTURAL_EDIT =
  /\b(?:add|insert|delete|remove|drop|cut|split|merge|combine|duplicate|reorder|swap|move)\s+(?:(?:a|an|the|new|another|one|two|three|extra|this|that|last|first)\s+)*(?:scenes?|shots?)\b/;

function normalize(message: string) {
  return message.toLowerCase().replace(/[’‘]/g, "'");
}

/** Keyword relevance of `text` to a specialist's domain (strong hits 1, weak hits 0.5). */
export function domainScore(text: string, id: SpecialistId): number {
  const normalized = normalize(text);
  const { strong, weak } = PATTERNS[id];
  const strongHits = Array.from(normalized.matchAll(strong)).length;
  const weakHits = weak ? Array.from(normalized.matchAll(weak)).length : 0;
  return strongHits + weakHits / 2;
}

/** Deterministic, zero-token routing. [] means "no specialist fits": fall back to refine. */
export function selectSpecialists(message: string): SpecialistId[] {
  const text = normalize(message);
  const review = REVIEW_INTENT.test(text);
  if (!review && STRUCTURAL_EDIT.test(text)) return [];
  const relevant = SPECIALIST_IDS.filter((id) => domainScore(text, id) >= 1);
  if (review && !relevant.length) return [...SPECIALIST_IDS];
  return relevant;
}
