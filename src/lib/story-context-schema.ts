import { z } from "zod";
import {
  MAX_CONTEXT_FACTS,
  MAX_FACT_VALUE,
  MAX_REMOVED_FACTS,
  MAX_UNRESOLVED,
  MAX_VISUAL_ENTITIES,
  MAX_VISUAL_NAME,
  STORY_CATEGORIES,
  type StoryCategoryId,
  VISUAL_KINDS,
} from "./story-context";

const categoryIds = STORY_CATEGORIES.map((category) => category.id) as [StoryCategoryId, ...StoryCategoryId[]];

export const storyCategorySchema = z.enum(categoryIds);

export const contextFactSchema = z.object({
  category: storyCategorySchema,
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(MAX_FACT_VALUE),
  source: z.enum(["user", "ai"]),
  approved: z.boolean(),
  answer: z.number().int().min(0).max(100).optional(),
});

export const visualEntitySchema = z.object({
  name: z.string().trim().min(1).max(MAX_VISUAL_NAME),
  kind: z.enum(VISUAL_KINDS),
  key: z.boolean(),
  asked: z.number().int().min(0).max(100).optional(),
  closed: z.boolean().optional(),
  central: z.boolean().optional(),
});

export const removedFactSchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(MAX_FACT_VALUE),
});

export const storyContextSchema = z.object({
  facts: z.array(contextFactSchema).max(MAX_CONTEXT_FACTS),
  unresolved: z.array(z.string().trim().min(1).max(300)).max(MAX_UNRESOLVED),
  removed: z.array(removedFactSchema).max(MAX_REMOVED_FACTS).optional(),
  visuals: z.array(visualEntitySchema).max(MAX_VISUAL_ENTITIES).optional(),
});
