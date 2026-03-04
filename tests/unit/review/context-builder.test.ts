import { describe, expect, it } from "vitest";
import { buildReviewContext } from "@/lib/review/context-builder";
import type { AstFileContext } from "@/types/review";
import {
  createAstFileContext,
  createAstImport,
  createAstScope,
  createDiffHunk,
  createDiffLine,
  createParsedDiff,
  createParsedDiffFile,
} from "../../helpers/factories";

describe("buildReviewContext", () => {
  const emptyAstMap = new Map<string, AstFileContext>();
  const emptyContentMap = new Map<string, string>();

  // --- No reviewable files ---

  it("returns CONTEXT_NO_REVIEWABLE_FILES when all files are binary", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ isBinary: true })],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("CONTEXT_NO_REVIEWABLE_FILES");
  });

  it("returns CONTEXT_NO_REVIEWABLE_FILES when all files are deleted", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ changeType: "deleted" })],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("CONTEXT_NO_REVIEWABLE_FILES");
  });

  it("returns CONTEXT_NO_REVIEWABLE_FILES when all hunks are empty", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ hunks: [] })],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("CONTEXT_NO_REVIEWABLE_FILES");
  });

  it("returns CONTEXT_NO_REVIEWABLE_FILES when files array is empty", () => {
    const diff = createParsedDiff({ files: [] });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("CONTEXT_NO_REVIEWABLE_FILES");
  });

  // --- Filtering ---

  it("filters out binary files from review", () => {
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "binary.wasm", isBinary: true }),
        createParsedDiffFile({ filePath: "src/code.ts", isBinary: false }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.files[0]?.filePath).toBe("src/code.ts");
  });

  it("filters out deleted files from review", () => {
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "deleted.ts", changeType: "deleted" }),
        createParsedDiffFile({
          filePath: "src/kept.ts",
          changeType: "modified",
        }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const allFiles = result.data.flatMap((c) => c.files);
    expect(allFiles).toHaveLength(1);
    expect(allFiles[0]?.filePath).toBe("src/kept.ts");
  });

  // --- AST enrichment ---

  it("enriches hunks with enclosing AST scopes", () => {
    const hunk = createDiffHunk({ newStart: 5, newCount: 10 });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/code.ts", hunks: [hunk] })],
    });
    const astMap = new Map<string, AstFileContext>([
      [
        "src/code.ts",
        createAstFileContext({
          filePath: "src/code.ts",
          scopes: [
            createAstScope({ name: "overlapping", startLine: 3, endLine: 20 }),
            createAstScope({ name: "outside", startLine: 30, endLine: 40 }),
          ],
        }),
      ],
    ]);

    const result = buildReviewContext(diff, astMap, emptyContentMap);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const enrichedHunks = result.data[0]?.files[0]?.enrichedHunks ?? [];
    expect(enrichedHunks).toHaveLength(1);
    expect(enrichedHunks[0]?.enclosingScopes).toHaveLength(1);
    expect(enrichedHunks[0]?.enclosingScopes[0]?.name).toBe("overlapping");
  });

  it("handles files with no AST context gracefully", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/no-ast.ts" })],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const file = result.data[0]?.files[0];
    expect(file?.imports).toEqual([]);
    for (const eh of file?.enrichedHunks ?? []) {
      expect(eh.enclosingScopes).toEqual([]);
    }
  });

  it("handles files with no file content gracefully", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/no-content.ts" })],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0]?.files[0]?.fullFileContent).toBeNull();
  });

  it("includes imports from AST context", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/with-imports.ts" })],
    });
    const astMap = new Map<string, AstFileContext>([
      [
        "src/with-imports.ts",
        createAstFileContext({
          filePath: "src/with-imports.ts",
          imports: [
            createAstImport({ source: "react", specifiers: ["useState"] }),
          ],
        }),
      ],
    ]);

    const result = buildReviewContext(diff, astMap, emptyContentMap);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data[0]?.files[0]?.imports).toHaveLength(1);
    expect(result.data[0]?.files[0]?.imports[0]?.source).toBe("react");
  });

  // --- Prioritization ---

  it("prioritizes security-sensitive files first", () => {
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "src/utils.ts" }),
        createParsedDiffFile({ filePath: "src/auth/login.ts" }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const allFiles = result.data.flatMap((c) => c.files);
    expect(allFiles[0]?.filePath).toBe("src/auth/login.ts");
  });

  it("sorts non-security files by changed line count descending", () => {
    const smallHunk = createDiffHunk({
      lines: [createDiffLine({ type: "added" })],
    });
    const largeHunk = createDiffHunk({
      lines: [
        createDiffLine({ type: "added" }),
        createDiffLine({ type: "added" }),
        createDiffLine({ type: "added" }),
        createDiffLine({ type: "removed" }),
        createDiffLine({ type: "removed" }),
      ],
    });

    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "src/small.ts", hunks: [smallHunk] }),
        createParsedDiffFile({ filePath: "src/large.ts", hunks: [largeHunk] }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const allFiles = result.data.flatMap((c) => c.files);
    expect(allFiles[0]?.filePath).toBe("src/large.ts");
    expect(allFiles[1]?.filePath).toBe("src/small.ts");
  });

  // --- Chunking ---

  it("puts all files in one chunk when under token limit", () => {
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "src/a.ts" }),
        createParsedDiffFile({ filePath: "src/b.ts" }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.files).toHaveLength(2);
  });

  it("chunks files to stay within max token budget", () => {
    // Use a very small max to force chunking
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "src/a.ts" }),
        createParsedDiffFile({ filePath: "src/b.ts" }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap, {
      maxTokensPerChunk: 1,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // With maxTokens=1, each file should be in its own chunk
    expect(result.data.length).toBeGreaterThanOrEqual(2);
  });

  it("places single large file into its own chunk", () => {
    const bigLines = Array.from({ length: 100 }, (_, i) =>
      createDiffLine({
        type: "added",
        content: `const variable${i} = "value that is moderately long to inflate token count";`,
        newLineNumber: i + 1,
      }),
    );
    const bigHunk = createDiffHunk({ lines: bigLines });

    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "src/big.ts", hunks: [bigHunk] }),
        createParsedDiffFile({ filePath: "src/small.ts" }),
      ],
    });

    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap, {
      maxTokensPerChunk: 500,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.length).toBeGreaterThanOrEqual(2);
  });

  it("estimates token count as roughly chars/4", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/code.ts" })],
    });
    const result = buildReviewContext(diff, emptyAstMap, emptyContentMap);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Token count should be a positive integer
    expect(result.data[0]?.estimatedTokenCount).toBeGreaterThan(0);
    expect(Number.isInteger(result.data[0]?.estimatedTokenCount)).toBe(true);
  });
});
