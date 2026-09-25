import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: [
    "src/**/*.{ts,tsx,css}",
    "worker/**/*.ts",
    "tests/**/*.ts",
    "prisma/**/*.prisma",
  ],
  // Vendored shadcn/ui components keep their full API even when only part of
  // it is used.
  ignore: ["src/components/ui/**"],
  ignoreDependencies: [
    // Imported by the generated client in src/generated, which is gitignored.
    "@prisma/client",
    // Grammar .wasm files loaded by package name in src/lib/review/ast-parser.ts.
    /^tree-sitter-/,
  ],
};

export default config;
