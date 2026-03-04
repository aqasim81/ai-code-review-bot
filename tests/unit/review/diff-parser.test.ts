import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import {
  BINARY_FILE_DIFF,
  DELETED_FILE_DIFF,
  EMPTY_DIFF,
  LARGE_DIFF_MANY_FILES,
  MULTI_FILE_DIFF,
  MULTI_HUNK_DIFF,
  NEW_FILE_DIFF,
  NO_NEWLINE_AT_END_DIFF,
  NON_REVIEWABLE_FILES_DIFF,
  RENAMED_FILE_DIFF,
  SECURITY_SENSITIVE_DIFF,
  SINGLE_FILE_TYPESCRIPT_DIFF,
  WHITESPACE_ONLY_DIFF,
} from "../../fixtures/diffs";

describe("parseUnifiedDiff", () => {
  // --- Empty / invalid input ---

  it("returns DIFF_EMPTY error for empty string", () => {
    const result = parseUnifiedDiff(EMPTY_DIFF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("DIFF_EMPTY");
    }
  });

  it("returns DIFF_EMPTY error for whitespace-only string", () => {
    const result = parseUnifiedDiff(WHITESPACE_ONLY_DIFF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("DIFF_EMPTY");
    }
  });

  // --- Single file parsing ---

  it("parses single TypeScript file with one hunk", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.files).toHaveLength(1);
    const file = result.data.files[0];
    expect(file?.filePath).toBe("src/lib/utils.ts");
    expect(file?.language).toBe("typescript");
    expect(file?.changeType).toBe("modified");
    expect(file?.isBinary).toBe(false);
    expect(file?.hunks).toHaveLength(1);
  });

  it("extracts hunk line numbers correctly", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;

    const hunk = result.data.files[0]?.hunks[0];
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.oldCount).toBe(4);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.newCount).toBe(6);
  });

  it("classifies diff lines as added, removed, or context", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;

    const lines = result.data.files[0]?.hunks[0]?.lines ?? [];
    const addedLines = lines.filter((l) => l.type === "added");
    const removedLines = lines.filter((l) => l.type === "removed");
    const contextLines = lines.filter((l) => l.type === "context");

    expect(addedLines.length).toBeGreaterThan(0);
    expect(removedLines.length).toBeGreaterThan(0);
    expect(contextLines.length).toBeGreaterThan(0);
  });

  it("tracks new line numbers for added lines", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;

    const lines = result.data.files[0]?.hunks[0]?.lines ?? [];
    const addedLines = lines.filter((l) => l.type === "added");
    for (const line of addedLines) {
      expect(line.newLineNumber).toBeTypeOf("number");
      expect(line.oldLineNumber).toBeNull();
    }
  });

  it("tracks old line numbers for removed lines", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;

    const lines = result.data.files[0]?.hunks[0]?.lines ?? [];
    const removedLines = lines.filter((l) => l.type === "removed");
    for (const line of removedLines) {
      expect(line.oldLineNumber).toBeTypeOf("number");
      expect(line.newLineNumber).toBeNull();
    }
  });

  it("tracks both line numbers for context lines", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;

    const lines = result.data.files[0]?.hunks[0]?.lines ?? [];
    const contextLines = lines.filter((l) => l.type === "context");
    for (const line of contextLines) {
      expect(line.oldLineNumber).toBeTypeOf("number");
      expect(line.newLineNumber).toBeTypeOf("number");
    }
  });

  // --- Multiple files ---

  it("parses multiple files from a single diff", () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.files).toHaveLength(3);
    expect(result.data.files[0]?.filePath).toBe("src/lib/auth.ts");
    expect(result.data.files[1]?.filePath).toBe("src/lib/handler.py");
    expect(result.data.files[2]?.filePath).toBe("src/main.go");
  });

  // --- Language detection ---

  it("detects TypeScript from .ts extension", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;
    expect(result.data.files[0]?.language).toBe("typescript");
  });

  it("detects Python from .py extension", () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    if (!result.success) return;
    expect(result.data.files[1]?.language).toBe("python");
  });

  it("detects Go from .go extension", () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    if (!result.success) return;
    expect(result.data.files[2]?.language).toBe("go");
  });

  it("returns null language for unknown extensions", () => {
    const diff = `diff --git a/README.md b/README.md
index abc..def 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Title
+New line
 End
`;
    const result = parseUnifiedDiff(diff);
    if (!result.success) return;
    expect(result.data.files[0]?.language).toBeNull();
  });

  // --- Change type detection ---

  it("identifies added files (new file mode)", () => {
    const result = parseUnifiedDiff(NEW_FILE_DIFF);
    if (!result.success) return;
    expect(result.data.files[0]?.changeType).toBe("added");
  });

  it("identifies deleted files (+++ /dev/null)", () => {
    const result = parseUnifiedDiff(DELETED_FILE_DIFF);
    if (!result.success) return;
    expect(result.data.files[0]?.changeType).toBe("deleted");
    expect(result.data.files[0]?.filePath).toBe("src/lib/old-module.ts");
  });

  it("identifies renamed files (rename from/to)", () => {
    const result = parseUnifiedDiff(RENAMED_FILE_DIFF);
    if (!result.success) return;
    const file = result.data.files[0];
    expect(file?.changeType).toBe("renamed");
    expect(file?.filePath).toBe("src/lib/new-name.ts");
    expect(file?.previousFilePath).toBe("src/lib/old-name.ts");
  });

  it("identifies modified files as default", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;
    expect(result.data.files[0]?.changeType).toBe("modified");
  });

  // --- Binary files ---

  it("detects binary files and sets isBinary flag", () => {
    const result = parseUnifiedDiff(BINARY_FILE_DIFF);
    if (!result.success) return;

    // The binary PNG should be filtered as non-reviewable (.png)
    // But the code file should be present
    const codeFile = result.data.files.find(
      (f) => f.filePath === "src/lib/code.ts",
    );
    expect(codeFile).toBeDefined();
    expect(codeFile?.isBinary).toBe(false);
  });

  // --- Non-reviewable files ---

  it("filters out non-reviewable files (lock files, .min.js, images)", () => {
    const result = parseUnifiedDiff(NON_REVIEWABLE_FILES_DIFF);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // All files are non-reviewable (lock, .min.js, .png)
    expect(result.data.files).toHaveLength(0);
  });

  it("returns empty files when all files are non-reviewable", () => {
    const result = parseUnifiedDiff(NON_REVIEWABLE_FILES_DIFF);
    if (!result.success) return;
    expect(result.data.files).toEqual([]);
  });

  // --- Multiple hunks ---

  it("parses multiple hunks within one file", () => {
    const result = parseUnifiedDiff(MULTI_HUNK_DIFF);
    if (!result.success) return;

    expect(result.data.files).toHaveLength(1);
    expect(result.data.files[0]?.hunks).toHaveLength(2);
  });

  // --- Edge cases ---

  it("handles 'no newline at end of file' marker", () => {
    const result = parseUnifiedDiff(NO_NEWLINE_AT_END_DIFF);
    if (!result.success) return;

    const lines = result.data.files[0]?.hunks[0]?.lines ?? [];
    // The marker should not appear as a diff line
    const markerLines = lines.filter((l) =>
      l.content.includes("No newline at end of file"),
    );
    expect(markerLines).toHaveLength(0);
  });

  it("strips leading +/- from diff line content", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;

    const lines = result.data.files[0]?.hunks[0]?.lines ?? [];
    for (const line of lines) {
      expect(line.content).not.toMatch(/^[+-]/);
    }
  });

  // --- Security sensitive files ---

  it("includes security-sensitive files (auth/token paths)", () => {
    const result = parseUnifiedDiff(SECURITY_SENSITIVE_DIFF);
    if (!result.success) return;

    expect(result.data.files).toHaveLength(1);
    expect(result.data.files[0]?.filePath).toBe(
      "src/lib/auth/token-validator.ts",
    );
  });

  // --- Large diffs ---

  it("parses large diffs with many files", () => {
    const result = parseUnifiedDiff(LARGE_DIFF_MANY_FILES);
    if (!result.success) return;

    expect(result.data.files).toHaveLength(10);
    for (const file of result.data.files) {
      expect(file.hunks.length).toBeGreaterThan(0);
    }
  });

  // --- previousFilePath ---

  it("returns null previousFilePath for non-renamed files", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_TYPESCRIPT_DIFF);
    if (!result.success) return;
    expect(result.data.files[0]?.previousFilePath).toBeNull();
  });

  it("returns previousFilePath from 'rename from' header", () => {
    const result = parseUnifiedDiff(RENAMED_FILE_DIFF);
    if (!result.success) return;
    expect(result.data.files[0]?.previousFilePath).toBe("src/lib/old-name.ts");
  });
});
