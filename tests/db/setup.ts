import { afterAll, beforeEach, vi } from "vitest";
import { disconnectTestDatabase, resetTestDatabase } from "./database";

// The db and queue projects run against a real Postgres (and the queue
// project a real Valkey). Every test empties the tables, so only a database
// named *_test is accepted.
vi.mock("@/lib/env", () => {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/ai_code_review_test";
  if (!new URL(databaseUrl).pathname.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL must name a database ending in _test: ${databaseUrl}`,
    );
  }
  return {
    env: {
      DATABASE_URL: databaseUrl,
      VALKEY_URL: process.env.TEST_VALKEY_URL ?? "redis://localhost:6380",
      NODE_ENV: "test",
      LLM_MODEL_ID: "configured-model",
    },
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});
