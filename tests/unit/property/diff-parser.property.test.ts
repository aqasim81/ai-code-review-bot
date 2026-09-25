import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import type { DiffHunk, ParsedDiff } from "@/types/review";
import { generatedDiffArbitrary } from "../../helpers/diff-arbitrary";

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
  // A diff's last line can end in whitespace; it belongs to the line (#108).
  function singleHunkDiff(header: string, lines: readonly string[]): string {
    return [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      header,
      ...lines,
      "",
    ].join("\n");
  }

  it("keeps a blank context line at the end of the diff (#108)", () => {
    const [file] = parseOrFail(singleHunkDiff("@@ -1,1 +1,1 @@", [" "])).files;

    expect(file?.hunks[0]?.lines).toEqual([
      { type: "context", content: "", oldLineNumber: 1, newLineNumber: 1 },
    ]);
  });

  it("keeps trailing spaces on the diff's last added line (#108)", () => {
    const raw = singleHunkDiff("@@ -1,0 +1,2 @@", ["+x", "+  indented  "]);

    const [file] = parseOrFail(raw).files;

    expect(file?.hunks[0]?.lines.map((line) => line.content)).toEqual([
      "x",
      "  indented  ",
    ]);
  });

  it("parses every generated file and hunk with the lines it was built from", () => {
    fc.assert(
      fc.property(generatedDiffArbitrary, (generated) => {
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
