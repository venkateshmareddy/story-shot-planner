import { z } from "zod";

export const FILM_FORMATS = [
  "short_film",
  "feature_film",
  "web_series",
  "documentary",
  "advertisement",
  "music_video",
] as const;

export type FilmFormat = (typeof FILM_FORMATS)[number];

export type FormatStructure = "flat" | "acts" | "season_episode" | "segments" | "beats";

export type FormatProfile = {
  id: FilmFormat;
  label: string;
  enabled: boolean;
  tagline: string;
  structure: FormatStructure;
  targetRuntimeSeconds: readonly [number, number];
  shotPacingSeconds: readonly [number, number];
  contentKinds: readonly string[];
};

export const FORMAT_REGISTRY: Record<FilmFormat, FormatProfile> = {
  short_film: {
    id: "short_film",
    label: "Short film",
    enabled: true,
    tagline: "A single, focused dramatic idea told in a few minutes.",
    structure: "flat",
    targetRuntimeSeconds: [60, 900],
    shotPacingSeconds: [3, 6],
    contentKinds: ["dialogue", "voiceover"],
  },
  feature_film: {
    id: "feature_film",
    label: "Feature film",
    enabled: false,
    tagline: "A full-length narrative built across distinct acts.",
    structure: "acts",
    targetRuntimeSeconds: [4_800, 10_800],
    shotPacingSeconds: [3, 12],
    contentKinds: ["dialogue", "voiceover"],
  },
  web_series: {
    id: "web_series",
    label: "Web series",
    enabled: false,
    tagline: "Episodic storytelling across a connected season.",
    structure: "season_episode",
    targetRuntimeSeconds: [300, 1_800],
    shotPacingSeconds: [3, 8],
    contentKinds: ["dialogue", "voiceover"],
  },
  documentary: {
    id: "documentary",
    label: "Documentary",
    enabled: false,
    tagline: "Real subjects and evidence shaped into a narrative.",
    structure: "segments",
    targetRuntimeSeconds: [600, 7_200],
    shotPacingSeconds: [4, 15],
    contentKinds: ["dialogue", "voiceover", "interview"],
  },
  advertisement: {
    id: "advertisement",
    label: "Advertisement",
    enabled: false,
    tagline: "A tight, persuasive spot built around one message.",
    structure: "beats",
    targetRuntimeSeconds: [6, 90],
    shotPacingSeconds: [1, 4],
    contentKinds: ["voiceover", "title", "dialogue"],
  },
  music_video: {
    id: "music_video",
    label: "Music video",
    enabled: false,
    tagline: "Visuals cut to the rhythm and story of a track.",
    structure: "beats",
    targetRuntimeSeconds: [90, 360],
    shotPacingSeconds: [1, 5],
    contentKinds: ["lyric", "voiceover"],
  },
};

export const DEFAULT_FORMAT: FilmFormat = "short_film";

export function getFormatProfile(id: FilmFormat): FormatProfile {
  return FORMAT_REGISTRY[id];
}

export function isEnabledFormat(id: string): id is FilmFormat {
  return id in FORMAT_REGISTRY && FORMAT_REGISTRY[id as FilmFormat].enabled;
}

export function enabledFormats(): FilmFormat[] {
  return FILM_FORMATS.filter((id) => FORMAT_REGISTRY[id].enabled);
}

export const formatSchema = z.enum(FILM_FORMATS).refine((id) => FORMAT_REGISTRY[id].enabled, {
  message: "This filmmaking format isn’t available yet.",
});
