// Invariant 6 (CLAUDE.md): no AI or LLM provider names in code, comments,
// prompts or user-facing strings, except model IDs, the SDK dependency and its
// API-key env var. This file has to spell out the names it looks for, so it is
// the one documented exception.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SCANNED_DIRS = ["src", "worker"];
const SKIPPED_DIRS = new Set([path.join(ROOT, "src", "generated")]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const ALLOWED_MENTIONS = [
  /ANTHROPIC_API_KEY/g,
  /["']@anthropic-ai\/sdk["']/g,
  /["']claude-[a-z0-9.-]+["']/g,
];

const PROVIDER_NAME =
  /\b(anthropic|claude|openai|chatgpt|gpt-\d|gemini|mistral)\b/i;

function findProviderName(line: string): string | null {
  const withoutAllowed = ALLOWED_MENTIONS.reduce(
    (text, allowed) => text.replace(allowed, ""),
    line,
  );
  return PROVIDER_NAME.exec(withoutAllowed)?.[0] ?? null;
}

function listSourceFiles(dir: string): string[] {
  if (SKIPPED_DIRS.has(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath);
    return SCANNED_EXTENSIONS.has(path.extname(entry)) ? [fullPath] : [];
  });
}

describe("findProviderName", () => {
  it("allows the SDK import, its API-key env var and model IDs", () => {
    expect(findProviderName('import LlmSdk from "@anthropic-ai/sdk";')).toBe(
      null,
    );
    expect(findProviderName("const key = env.ANTHROPIC_API_KEY;")).toBe(null);
    expect(findProviderName('const MODEL = "claude-sonnet-4-20250514";')).toBe(
      null,
    );
  });

  it("flags provider names anywhere else", () => {
    expect(findProviderName("// Generated with Claude")).toBe("Claude");
    expect(findProviderName('const label = "Powered by OpenAI";')).toBe(
      "OpenAI",
    );
    expect(findProviderName("summarise with gpt-4 first")).toBe("gpt-4");
  });
});

describe("invariant 6: no provider names in shipped code", () => {
  it("finds none in src/ or worker/", () => {
    const violations = SCANNED_DIRS.flatMap((dir) =>
      listSourceFiles(path.join(ROOT, dir)),
    ).flatMap((file) =>
      readFileSync(file, "utf-8")
        .split("\n")
        .flatMap((line, index) => {
          const name = findProviderName(line);
          return name
            ? [`${path.relative(ROOT, file)}:${index + 1} (${name})`]
            : [];
        }),
    );

    expect(violations).toEqual([]);
  });
});
