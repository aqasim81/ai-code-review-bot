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

  // Required — consumed by GitHub OAuth (Phase 5: Dashboard)
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  VALKEY_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(1),
  NEXTAUTH_URL: z.string().url(),
  GITHUB_APP_SLUG: z.string().min(1).default("code-review-bot"),
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
