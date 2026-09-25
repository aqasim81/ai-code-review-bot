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

/**
 * Stored settings with each missing or invalid field replaced by its default.
 * The column is JSON, so a stored value is checked against the same schema a
 * save uses before anything relies on it.
 */
export function mergeWithDefaults(
  stored: unknown,
): Required<RepositorySettings> {
  const raw: Record<string, unknown> =
    stored !== null && typeof stored === "object" ? { ...stored } : {};
  const fields = repositorySettingsSchema.shape;

  return {
    enabledCategories: validOrDefault(
      fields.enabledCategories,
      knownCategoriesOnly(raw.enabledCategories),
      DEFAULT_REPOSITORY_SETTINGS.enabledCategories,
    ),
    minimumSeverity: validOrDefault(
      fields.minimumSeverity,
      raw.minimumSeverity,
      DEFAULT_REPOSITORY_SETTINGS.minimumSeverity,
    ),
    excludePatterns: validOrDefault(
      fields.excludePatterns,
      raw.excludePatterns,
      DEFAULT_REPOSITORY_SETTINGS.excludePatterns,
    ),
    customInstructions: validOrDefault(
      fields.customInstructions,
      raw.customInstructions,
      DEFAULT_REPOSITORY_SETTINGS.customInstructions,
    ),
  };
}

// A category removed from the enum stays in stored JSON; dropping it keeps the
// owner's other choices instead of turning every category back on.
function knownCategoriesOnly(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const category = z.enum(CommentCategory);
  return value.filter((item) => category.safeParse(item).success);
}

function validOrDefault<T>(
  schema: z.ZodType<T>,
  value: unknown,
  fallback: T,
): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
