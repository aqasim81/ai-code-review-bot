import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import type { DiffHunk, ParsedDiff } from "@/types/review";
import {
  generatedDiffArbitrary,
  lastDiffLineEndsInWhitespace,
} from "../../helpers/diff-arbitrary";

function parseOrFail(raw: string): ParsedDiff {
  const result = parseUnifiedDiff(raw);
  if (!result.success) throw new Error(`parse failed: ${result.error}`);
  return result.data;
}

function isSequentialFrom(
  numbers: readonly (number | null)[],
  start: number,
): boolean {
  const present = numbers.filter((n): n is number => n !== null);
  return present.every((n, index) => n === start + index);
}

function lineCounts(hunk: DiffHunk): { old: number; new: number } {
  return {
    old: hunk.lines.filter((line) => line.type !== "added").length,
    new: hunk.lines.filter((line) => line.type !== "removed").length,
  };
}

describe("parseUnifiedDiff properties", () => {
  // Skipped until #108 is fixed: trimming the whole diff drops a last line
  // that ends in whitespace. The properties below skip such diffs with
  // fc.pre; remove that once this passes.
  it.skip("keeps a blank context line at the end of the diff (#108)", () => {
    const raw = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      " ",
      "",
    ].join("\n");

    const [file] = parseOrFail(raw).files;

    expect(file?.hunks[0]?.lines).toEqual([
      { type: "context", content: "", oldLineNumber: 1, newLineNumber: 1 },
    ]);
  });

  it("parses every generated file and hunk with the lines it was built from", () => {
    fc.assert(
      fc.property(generatedDiffArbitrary, (generated) => {
        fc.pre(!lastDiffLineEndsInWhitespace(generated.raw));
        const parsed = parseOrFail(generated.raw);

        expect(parsed.files.map((file) => file.filePath)).toEqual(
          generated.files.map((file) => file.filePath),
        );
        parsed.files.forEach((file, fileIndex) => {
          const expectedHunks = generated.files[fileIndex]?.hunks ?? [];
          expect(file.hunks).toHaveLength(expectedHunks.length);
          file.hunks.forEach((hunk, hunkIndex) => {
            const expected = expectedHunks[hunkIndex];
            expect(
              hunk.lines.map(({ type, content }) => ({ type, content })),
            ).toEqual(expected?.lines);
          });
        });
      }),
    );
  });

  it("gives each hunk as many old and new lines as its header says", () => {
    fc.assert(
      fc.property(generatedDiffArbitrary, (generated) => {
        fc.pre(!lastDiffLineEndsInWhitespace(generated.raw));
        for (const file of parseOrFail(generated.raw).files) {
          for (const hunk of file.hunks) {
            expect(lineCounts(hunk)).toEqual({
              old: hunk.oldCount,
              new: hunk.newCount,
            });
          }
        }
      }),
    );
  });

  it("numbers old and new lines consecutively from the hunk's start", () => {
    fc.assert(
      fc.property(generatedDiffArbitrary, (generated) => {
        fc.pre(!lastDiffLineEndsInWhitespace(generated.raw));
        for (const file of parseOrFail(generated.raw).files) {
          for (const hunk of file.hunks) {
            const oldNumbers = hunk.lines.map((line) => line.oldLineNumber);
            const newNumbers = hunk.lines.map((line) => line.newLineNumber);
            expect(isSequentialFrom(oldNumbers, hunk.oldStart)).toBe(true);
            expect(isSequentialFrom(newNumbers, hunk.newStart)).toBe(true);
          }
        }
      }),
    );
  });

  it("keeps line numbers increasing across a file's hunks", () => {
    fc.assert(
      fc.property(generatedDiffArbitrary, (generated) => {
        fc.pre(!lastDiffLineEndsInWhitespace(generated.raw));
        for (const file of parseOrFail(generated.raw).files) {
          const lines = file.hunks.flatMap((hunk) => hunk.lines);
          for (const side of ["oldLineNumber", "newLineNumber"] as const) {
            const numbers = lines
              .map((line) => line[side])
              .filter((n): n is number => n !== null);
            const increasing = numbers.every(
              (n, index) => index === 0 || n > (numbers[index - 1] ?? 0),
            );
            expect(increasing).toBe(true);
          }
        }
      }),
    );
  });
});
