import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "@/lib/llm/prompts";
import {
  createAstImport,
  createAstScope,
  createDiffHunk,
  createDiffLine,
  createEnrichedHunk,
  createFileReviewContext,
  createReviewChunk,
} from "../../helpers/factories";

describe("buildReviewPrompt", () => {
  it("returns object with system and user string properties", () => {
    const chunk = createReviewChunk();
    const result = buildReviewPrompt(chunk);

    expect(result).toHaveProperty("system");
    expect(result).toHaveProperty("user");
    expect(typeof result.system).toBe("string");
    expect(typeof result.user).toBe("string");
  });

  it("includes file path in user prompt", () => {
    const chunk = createReviewChunk({
      files: [createFileReviewContext({ filePath: "src/lib/special.ts" })],
    });
    const result = buildReviewPrompt(chunk);

    expect(result.user).toContain("src/lib/special.ts");
  });

  it("includes language and change type", () => {
    const chunk = createReviewChunk({
      files: [
        createFileReviewContext({
          language: "python",
          changeType: "added",
        }),
      ],
    });
    const result = buildReviewPrompt(chunk);

    expect(result.user).toContain("python");
    expect(result.user).toContain("added");
  });

  it("includes import summary when imports are present", () => {
    const chunk = createReviewChunk({
      files: [
        createFileReviewContext({
          imports: [
            createAstImport({
              source: "react",
              specifiers: ["useState", "useEffect"],
              isDefault: false,
            }),
          ],
        }),
      ],
    });
    const result = buildReviewPrompt(chunk);

    expect(result.user).toContain("Imports:");
    expect(result.user).toContain("useState, useEffect");
    expect(result.user).toContain('"react"');
  });

  it("includes scope context for enriched hunks", () => {
    const chunk = createReviewChunk({
      files: [
        createFileReviewContext({
          enrichedHunks: [
            createEnrichedHunk({
              enclosingScopes: [
                createAstScope({
                  type: "function",
                  name: "processData",
                  startLine: 5,
                  endLine: 25,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const result = buildReviewPrompt(chunk);

    expect(result.user).toContain("Scope:");
    expect(result.user).toContain('function "processData"');
    expect(result.user).toContain("lines 5-25");
  });

  it("includes hunk header and diff lines with +/- prefixes", () => {
    const hunk = createDiffHunk({
      header: "@@ -1,3 +1,4 @@",
      lines: [
        createDiffLine({
          type: "context",
          content: "const a = 1;",
          newLineNumber: 1,
          oldLineNumber: 1,
        }),
        createDiffLine({
          type: "added",
          content: "const b = 2;",
          newLineNumber: 2,
          oldLineNumber: null,
        }),
        createDiffLine({
          type: "removed",
          content: "const c = 3;",
          newLineNumber: null,
          oldLineNumber: 2,
        }),
      ],
    });
    const chunk = createReviewChunk({
      files: [
        createFileReviewContext({
          enrichedHunks: [createEnrichedHunk({ hunk, enclosingScopes: [] })],
        }),
      ],
    });
    const result = buildReviewPrompt(chunk);

    expect(result.user).toContain("@@ -1,3 +1,4 @@");
    expect(result.user).toContain("+ L2: const b = 2;");
    expect(result.user).toContain("- L2: const c = 3;");
    expect(result.user).toContain("  L1: const a = 1;");
  });

  it("formats multiple files", () => {
    const chunk = createReviewChunk({
      files: [
        createFileReviewContext({ filePath: "src/file-a.ts" }),
        createFileReviewContext({ filePath: "src/file-b.ts" }),
      ],
    });
    const result = buildReviewPrompt(chunk);

    expect(result.user).toContain("src/file-a.ts");
    expect(result.user).toContain("src/file-b.ts");
  });

  it("system prompt contains category definitions", () => {
    const chunk = createReviewChunk();
    const result = buildReviewPrompt(chunk);

    expect(result.system).toContain("SECURITY");
    expect(result.system).toContain("BUGS");
    expect(result.system).toContain("PERFORMANCE");
    expect(result.system).toContain("STYLE");
    expect(result.system).toContain("BEST_PRACTICES");
  });

  it("system prompt contains severity definitions", () => {
    const chunk = createReviewChunk();
    const result = buildReviewPrompt(chunk);

    expect(result.system).toContain("CRITICAL");
    expect(result.system).toContain("WARNING");
    expect(result.system).toContain("SUGGESTION");
    expect(result.system).toContain("NITPICK");
  });

  it("system prompt contains output format instructions", () => {
    const chunk = createReviewChunk();
    const result = buildReviewPrompt(chunk);

    expect(result.system).toContain("JSON");
    expect(result.system).toContain("filePath");
    expect(result.system).toContain("lineNumber");
    expect(result.system).toContain("confidence");
  });

  it("shows 'unknown' for null language", () => {
    const chunk = createReviewChunk({
      files: [createFileReviewContext({ language: null })],
    });
    const result = buildReviewPrompt(chunk);

    expect(result.user).toContain("unknown");
  });
});
