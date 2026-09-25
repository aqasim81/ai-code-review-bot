import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mapFindingsToGitHubComments } from "@/lib/review/comment-mapper";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import type { DiffLine, ParsedDiff, ParsedDiffFile } from "@/types/review";
import { generatedDiffArbitrary } from "../../helpers/diff-arbitrary";
import { createReviewFinding } from "../../helpers/factories";

const parsedDiffArbitrary: fc.Arbitrary<ParsedDiff> =
  generatedDiffArbitrary.map(({ raw }) => {
    const result = parseUnifiedDiff(raw);
    if (!result.success) throw new Error(`parse failed: ${result.error}`);
    return result.data;
  });

function allLines(file: ParsedDiffFile): DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.lines);
}

function isOnSide(
  file: ParsedDiffFile,
  side: "LEFT" | "RIGHT",
  lineNumber: number,
): boolean {
  return allLines(file).some((line) =>
    side === "RIGHT"
      ? line.newLineNumber === lineNumber
      : line.type === "removed" && line.oldLineNumber === lineNumber,
  );
}

describe("mapFindingsToGitHubComments properties", () => {
  it("maps a finding on any added or context line to RIGHT at that line", () => {
    fc.assert(
      fc.property(parsedDiffArbitrary, (diff) => {
        const findings = diff.files.flatMap((file) =>
          allLines(file)
            .filter((line) => line.newLineNumber !== null)
            .map((line) =>
              createReviewFinding({
                filePath: file.filePath,
                lineNumber: line.newLineNumber ?? 0,
              }),
            ),
        );

        const { mappedComments, unmappedFindings } =
          mapFindingsToGitHubComments(findings, diff);

        expect(unmappedFindings).toEqual([]);
        expect(
          mappedComments.map(({ path, line, side }) => ({ path, line, side })),
        ).toEqual(
          findings.map((finding) => ({
            path: finding.filePath,
            line: finding.lineNumber,
            side: "RIGHT",
          })),
        );
      }),
    );
  });

  it("maps nothing outside the diff", () => {
    const diffWithFindings = parsedDiffArbitrary.chain((diff) =>
      fc
        .array(
          fc.record({
            filePath: fc.constantFrom(
              ...diff.files.map((file) => file.filePath),
              "src/not-in-diff.ts",
            ),
            lineNumber: fc.integer({ min: 1, max: 200 }),
          }),
          { minLength: 1, maxLength: 10 },
        )
        .map((locations) => ({
          diff,
          findings: locations.map((location) => createReviewFinding(location)),
        })),
    );

    fc.assert(
      fc.property(diffWithFindings, ({ diff, findings }) => {
        const { mappedComments, unmappedFindings } =
          mapFindingsToGitHubComments(findings, diff);

        for (const comment of mappedComments) {
          const file = diff.files.find((f) => f.filePath === comment.path);
          expect(file).toBeDefined();
          if (file === undefined) continue;
          expect(isOnSide(file, comment.side, comment.line)).toBe(true);
        }
        for (const { finding } of unmappedFindings) {
          const file = diff.files.find((f) => f.filePath === finding.filePath);
          if (file === undefined) continue;
          expect(isOnSide(file, "RIGHT", finding.lineNumber)).toBe(false);
          expect(isOnSide(file, "LEFT", finding.lineNumber)).toBe(false);
        }
        expect(mappedComments.length + unmappedFindings.length).toBe(
          findings.length,
        );
      }),
    );
  });
});
