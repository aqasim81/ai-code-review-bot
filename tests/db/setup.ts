import { afterAll, beforeEach, vi } from "vitest";
import { disconnectTestDatabase, resetTestDatabase } from "./database";

// The db project runs src/lib/db/queries.ts against a real Postgres. Every
// test empties the tables, so only a database named *_test is accepted.
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
