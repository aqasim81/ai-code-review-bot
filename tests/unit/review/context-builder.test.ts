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

function linesOfCode(count: number) {
  return createDiffHunk({
    lines: Array.from({ length: count }, (_, i) =>
      createDiffLine({
        type: "added",
        content: `const variable${i} = "value that is moderately long to inflate token count";`,
        newLineNumber: i + 1,
      }),
    ),
  });
}

describe("buildReviewContext", () => {
  const emptyAstMap = new Map<string, AstFileContext>();

  // --- No reviewable files ---

  it("returns no chunks when all files are binary", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ isBinary: true })],
    });
    const result = buildReviewContext(diff, emptyAstMap);

    expect(result).toEqual({ chunks: [], oversizedFilePaths: [] });
  });

  it("returns no chunks when all files are deleted", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ changeType: "deleted" })],
    });
    const result = buildReviewContext(diff, emptyAstMap);

    expect(result).toEqual({ chunks: [], oversizedFilePaths: [] });
  });

  it("returns no chunks when all hunks are empty", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ hunks: [] })],
    });
    const result = buildReviewContext(diff, emptyAstMap);

    expect(result).toEqual({ chunks: [], oversizedFilePaths: [] });
  });

  it("returns no chunks when files array is empty", () => {
    const diff = createParsedDiff({ files: [] });
    const result = buildReviewContext(diff, emptyAstMap);

    expect(result).toEqual({ chunks: [], oversizedFilePaths: [] });
  });

  // --- Filtering ---

  it("filters out binary files from review", () => {
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "binary.wasm", isBinary: true }),
        createParsedDiffFile({ filePath: "src/code.ts", isBinary: false }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.files[0]?.filePath).toBe("src/code.ts");
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
    const result = buildReviewContext(diff, emptyAstMap);

    const allFiles = result.chunks.flatMap((c) => c.files);
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

    const result = buildReviewContext(diff, astMap);

    const enrichedHunks = result.chunks[0]?.files[0]?.enrichedHunks ?? [];
    expect(enrichedHunks).toHaveLength(1);
    expect(enrichedHunks[0]?.enclosingScopes).toHaveLength(1);
    expect(enrichedHunks[0]?.enclosingScopes[0]?.name).toBe("overlapping");
  });

  it("handles files with no AST context gracefully", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/no-ast.ts" })],
    });
    const result = buildReviewContext(diff, emptyAstMap);

    const file = result.chunks[0]?.files[0];
    expect(file?.imports).toEqual([]);
    for (const eh of file?.enrichedHunks ?? []) {
      expect(eh.enclosingScopes).toEqual([]);
    }
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

    const result = buildReviewContext(diff, astMap);

    expect(result.chunks[0]?.files[0]?.imports).toHaveLength(1);
    expect(result.chunks[0]?.files[0]?.imports[0]?.source).toBe("react");
  });

  // --- Prioritization ---

  it("prioritizes security-sensitive files first", () => {
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "src/utils.ts" }),
        createParsedDiffFile({ filePath: "src/auth/login.ts" }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap);

    const allFiles = result.chunks.flatMap((c) => c.files);
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
    const result = buildReviewContext(diff, emptyAstMap);

    const allFiles = result.chunks.flatMap((c) => c.files);
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
    const result = buildReviewContext(diff, emptyAstMap);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.files).toHaveLength(2);
  });

  it("chunks files to stay within max token budget", () => {
    // Each file is ~350 estimated tokens: two fit a 500-token chunk only apart.
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({
          filePath: "src/a.ts",
          hunks: [linesOfCode(15)],
        }),
        createParsedDiffFile({
          filePath: "src/b.ts",
          hunks: [linesOfCode(15)],
        }),
      ],
    });
    const result = buildReviewContext(diff, emptyAstMap, {
      maxTokensPerChunk: 500,
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.oversizedFilePaths).toEqual([]);
  });

  it("skips a file larger than a whole chunk and reports it", () => {
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({
          filePath: "fixtures/huge.json",
          hunks: [linesOfCode(100)],
        }),
        createParsedDiffFile({ filePath: "src/small.ts" }),
      ],
    });

    const result = buildReviewContext(diff, emptyAstMap, {
      maxTokensPerChunk: 500,
    });

    expect(result.oversizedFilePaths).toEqual(["fixtures/huge.json"]);
    const reviewed = result.chunks.flatMap((chunk) =>
      chunk.files.map((file) => file.filePath),
    );
    expect(reviewed).toEqual(["src/small.ts"]);
    for (const chunk of result.chunks) {
      expect(chunk.estimatedTokenCount).toBeLessThanOrEqual(500);
    }
  });

  it("estimates token count as roughly chars/4", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/code.ts" })],
    });
    const result = buildReviewContext(diff, emptyAstMap);

    // Token count should be a positive integer
    expect(result.chunks[0]?.estimatedTokenCount).toBeGreaterThan(0);
    expect(Number.isInteger(result.chunks[0]?.estimatedTokenCount)).toBe(true);
  });
});
