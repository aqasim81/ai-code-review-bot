import { afterEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/env");

const REQUIRED_ENV = {
  DATABASE_URL: "postgresql://test:test@localhost:5433/test",
  GITHUB_WEBHOOK_SECRET: "secret",
  GITHUB_APP_ID: "1",
  GITHUB_PRIVATE_KEY: "key",
  ANTHROPIC_API_KEY: "api-key",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  VALKEY_URL: "valkey://localhost:6380",
  NEXTAUTH_SECRET: "nextauth-secret",
  NEXTAUTH_URL: "http://localhost:3000",
} as const;

async function loadEnvWith(overrides: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries({
    ...REQUIRED_ENV,
    ...overrides,
  })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const { env } = await import("@/lib/env");
  return env;
}

describe("env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults the review model to the current model of the review tier", async () => {
    const env = await loadEnvWith({ LLM_MODEL_ID: undefined });

    expect(env.LLM_MODEL_ID).toBe("claude-sonnet-5");
  });

  it("uses the configured review model", async () => {
    const env = await loadEnvWith({ LLM_MODEL_ID: "claude-opus-5" });

    expect(env.LLM_MODEL_ID).toBe("claude-opus-5");
  });
});
