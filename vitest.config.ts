import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/db/prisma-client.ts",
        "src/lib/db/queries.ts",
        "src/lib/github/api.ts",
        "src/lib/github/user-installations.ts",
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
