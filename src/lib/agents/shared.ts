import type { z } from "zod";
import { PLAIN_LANGUAGE, SOURCE_RULES } from "@/lib/server/prompts";
import type { ShotPlan } from "@/lib/story-planning";
import type { EditField } from "./schemas";
import type { SpecialistId } from "./types";

export type SpecialistDefinition = {
  id: SpecialistId;
  role: string;
  instructions: string;
  /** Plan fields this specialist may propose edits for. */
  fields: readonly EditField[];
  /** Structured-output schema sent to the model. */
  schema: z.ZodType;
  maxOutputTokens: number;
  /** Only the plan slice this specialist needs. */
  buildContext: (plan: ShotPlan) => unknown;
};

export function shotId(sceneIndex: number, shotIndex: number) {
  const pad = (value: number) => String(value + 1).padStart(2, "0");
  return `S${pad(sceneIndex)}_SH${pad(shotIndex)}`;
}

export function clip(text: string, max = 400) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function specialistInstructions(role: string, expertise: string, fieldRules: string) {
  return [
    SOURCE_RULES,
    `You are the ${role} on a film's creative team. ${expertise}`,
    PLAIN_LANGUAGE,
    "Input: the filmmaker's message, recent conversation (recent), approved project decisions (approved) and the plan excerpt for your discipline (plan). Respond to the message within your discipline only. Honour approved decisions unless the filmmaker overrides them.",
    'summary: 1-3 sentences answering the filmmaker directly. recommendations: at most 4, most important first. target is a shot id like S01_SH02, "Scene 2", "Character: Name" or "Overall"; issue names what weakens the film; recommendation is specific and actionable; rationale explains its purpose for the audience or the production; priority is high, medium or low.',
    `edits: concrete replacement values, only when the filmmaker asks for a change or a clear fix exists in your discipline; otherwise []. scene and shot are 1-based and match the ids (S02_SH03 is scene 2, shot 3). ${fieldRules} value is the complete new text for that field. You recommend and propose; the filmmaker approves every edit.`,
    "Be concise, specific and production-minded. Never invent story events, characters or dialogue.",
  ].join("\n");
}
