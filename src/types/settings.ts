import { z } from "zod";
import type {
  CommentCategory,
  CommentSeverity,
} from "@/generated/prisma/enums";

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

export const DEFAULT_REPOSITORY_SETTINGS: Required<RepositorySettings> = {
  enabledCategories: [
    "SECURITY",
    "BUGS",
    "PERFORMANCE",
    "STYLE",
    "BEST_PRACTICES",
  ],
  minimumSeverity: "SUGGESTION",
  excludePatterns: [],
  customInstructions: "",
} as const;

export const repositorySettingsSchema = z.object({
  enabledCategories: z
    .array(
      z.enum(["SECURITY", "BUGS", "PERFORMANCE", "STYLE", "BEST_PRACTICES"]),
    )
    .min(1, "At least one category must be enabled"),
  minimumSeverity: z.enum(["CRITICAL", "WARNING", "SUGGESTION", "NITPICK"]),
  excludePatterns: z.array(z.string().max(200)).max(20),
  customInstructions: z.string().max(2000),
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
