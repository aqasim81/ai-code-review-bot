import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next compiles JSX itself (tsconfig "preserve"); tests that render
  // components need the automatic runtime.
  esbuild: { jsx: "automatic" },
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/db/**", "tests/queue/**"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
      // Runs the database queries against a real Postgres (`pnpm test:db`);
      // test files share one database, so they run one at a time.
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          setupFiles: ["./tests/db/setup.ts"],
          fileParallelism: false,
        },
      },
      // Runs review jobs through a real BullMQ worker on Valkey, with job
      // records in Postgres (`pnpm test:queue`).
      {
        extends: true,
        test: {
          name: "queue",
          include: ["tests/queue/**/*.test.ts"],
          setupFiles: ["./tests/db/setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/db/prisma-client.ts",
        "src/lib/db/queries.ts",
        "src/lib/github/api.ts",
        "src/lib/queue/connection.ts",
        "src/lib/queue/producer.ts",
        "src/lib/env.ts",
        "src/lib/logger.ts",
        "src/lib/utils.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 65,
        functions: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
