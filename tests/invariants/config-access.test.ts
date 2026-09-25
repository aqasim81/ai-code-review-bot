// Invariant 5 (CLAUDE.md): configuration only through src/lib/env.ts. Biome's
// noProcessEnv catches `process.env`; this scan covers the forms it misses.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const SKIPPED = new Set([
  path.join(SRC, "generated"),
  path.join(SRC, "lib", "env.ts"),
]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const RAW_CONFIG_ACCESS = [
  /\bprocess\s*\.\s*env\b/,
  /\bprocess\s*\[\s*["'`]env["'`]\s*\]/,
  /\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/,
];

function readsRawConfig(line: string): boolean {
  return RAW_CONFIG_ACCESS.some((pattern) => pattern.test(line));
}

function listSourceFiles(dir: string): string[] {
  if (SKIPPED.has(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (SKIPPED.has(fullPath)) return [];
    if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath);
    return SCANNED_EXTENSIONS.has(path.extname(entry)) ? [fullPath] : [];
  });
}

describe("readsRawConfig", () => {
  it("flags direct, bracket and destructured access", () => {
    expect(readsRawConfig("const key = process.env.SECRET;")).toBe(true);
    expect(readsRawConfig('const key = process["env"].SECRET;')).toBe(true);
    expect(readsRawConfig("const { env } = process;")).toBe(true);
    expect(readsRawConfig("const { env: vars } = globalThis.process;")).toBe(
      true,
    );
  });

  it("allows other uses of process", () => {
    expect(readsRawConfig("const root = process.cwd();")).toBe(false);
    expect(readsRawConfig('import { env } from "@/lib/env";')).toBe(false);
  });
});

describe("invariant 5: configuration only through src/lib/env.ts", () => {
  it("finds no raw config access elsewhere in src/", () => {
    const violations = listSourceFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf-8")
        .split("\n")
        .flatMap((line, index) =>
          readsRawConfig(line)
            ? [`${path.relative(ROOT, file)}:${index + 1}`]
            : [],
        ),
    );

    expect(violations).toEqual([]);
  });
});
