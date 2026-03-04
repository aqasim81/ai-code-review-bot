import { vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    DATABASE_URL: "postgresql://test:test@localhost:5433/test",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    NODE_ENV: "test",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "test-private-key",
    ANTHROPIC_API_KEY: "test-api-key",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    VALKEY_URL: "valkey://localhost:6380",
    NEXTAUTH_SECRET: "test-nextauth-secret",
    NEXTAUTH_URL: "http://localhost:3000",
    GITHUB_APP_SLUG: "test-bot",
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
