import { z } from "zod";
import { CommentCategory, CommentSeverity } from "@/generated/prisma/enums";

/**
 * Per-repository configuration stored in Repository.settings JSON column.
 * All fields are optional — missing fields use defaults at query time.
 */
export interface RepositorySettings {
  readonly enabledCategories?: readonly CommentCategory[];
  readonly minimumSeverity?: CommentSeverity;
  readonly excludePatterns?: readonly string[];
  readonly customInstructions?: string;
}

const DEFAULT_REPOSITORY_SETTINGS: Required<RepositorySettings> = {
  enabledCategories: Object.values(CommentCategory),
  minimumSeverity: "SUGGESTION",
  excludePatterns: [],
  customInstructions: "",
} as const;

// Postgres jsonb rejects NUL, so a setting containing one could never be saved.
const settingsTextSchema = z
  .string()
  .refine(
    (value) => !value.includes("\u0000"),
    "Settings can't contain NUL characters",
  );

export const repositorySettingsSchema = z.object({
  enabledCategories: z
    .array(z.enum(CommentCategory))
    .min(1, "At least one category must be enabled"),
  minimumSeverity: z.enum(CommentSeverity),
  excludePatterns: z.array(settingsTextSchema.max(200)).max(20),
  customInstructions: settingsTextSchema.max(2000),
});

export type RepositorySettingsInput = z.infer<typeof repositorySettingsSchema>;

export function mergeWithDefaults(
  stored: unknown,
): Required<RepositorySettings> {
  if (stored === null || stored === undefined || typeof stored !== "object") {
    return { ...DEFAULT_REPOSITORY_SETTINGS };
  }

  const raw = stored as Record<string, unknown>;

  return {
    enabledCategories: Array.isArray(raw.enabledCategories)
      ? (raw.enabledCategories as CommentCategory[])
      : [...DEFAULT_REPOSITORY_SETTINGS.enabledCategories],
    minimumSeverity:
      typeof raw.minimumSeverity === "string"
        ? (raw.minimumSeverity as CommentSeverity)
        : DEFAULT_REPOSITORY_SETTINGS.minimumSeverity,
    excludePatterns: Array.isArray(raw.excludePatterns)
      ? (raw.excludePatterns as string[])
      : [...DEFAULT_REPOSITORY_SETTINGS.excludePatterns],
    customInstructions:
      typeof raw.customInstructions === "string"
        ? raw.customInstructions
        : DEFAULT_REPOSITORY_SETTINGS.customInstructions,
  };
}
