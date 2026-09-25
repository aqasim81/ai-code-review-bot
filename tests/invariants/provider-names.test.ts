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
  /["']claude-(opus|sonnet|haiku)-\d[a-z0-9.-]*["']/g,
];

// No word boundaries, so names inside identifiers (createClaudeReview,
// OpenAIService) are caught. Names that are common English substrings (e.g.
// "cohere" in "coherent") are left out to avoid false positives.
const PROVIDER_NAME =
  /(anthropic|claude|openai|chatgpt|gpt-?\d|gemini|mistral|llama|deepseek|perplexity)/i;

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

  it("flags names inside identifiers and newer model families", () => {
    expect(findProviderName("const client = createClaudeReview();")).toBe(
      "Claude",
    );
    expect(findProviderName("class OpenAIService {}")).toBe("OpenAI");
    expect(findProviderName("const anthropicClient = build();")).toBe(
      "anthropic",
    );
    expect(findProviderName('const model = "gpt-4o";')).toBe("gpt-4");
    expect(findProviderName("switch to deepseek later")).toBe("deepseek");
  });

  it("only allows real model IDs, not any quoted claude- string", () => {
    expect(findProviderName('const tagline = "claude-powered";')).toBe(
      "claude",
    );
    expect(findProviderName('const MODEL = "claude-opus-4-1";')).toBe(null);
  });

  it("does not flag ordinary words that contain a provider-like substring", () => {
    expect(findProviderName("a coherent summary of the change")).toBe(null);
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
