import { z } from "zod";

const envSchema = z.object({
  // Required — used in existing code
  DATABASE_URL: z
    .string()
    .min(1)
    .startsWith("postgresql://", "Must be a PostgreSQL connection string"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Required — consumed by GitHub API client (Phase 3) and LLM client (Phase 2)
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),

  // Optional — features not yet implemented.
  // Remove .optional() when the consuming feature is built.
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  VALKEY_URL: z.string().min(1).optional(),
  NEXTAUTH_SECRET: z.string().min(1).optional(),
  NEXTAUTH_URL: z.string().url().optional(),
});

type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Environment variable validation failed:\n${formatted}\n\nCheck your .env.local file against .env.example`,
    );
  }

  return result.data;
}

export const env: Env = validateEnv();
