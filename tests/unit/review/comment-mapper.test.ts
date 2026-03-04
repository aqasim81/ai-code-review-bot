import { describe, expect, it } from "vitest";
import {
  buildReviewSummary,
  mapFindingsToGitHubComments,
} from "@/lib/review/comment-mapper";
import {
  createDiffHunk,
  createDiffLine,
  createParsedDiff,
  createParsedDiffFile,
  createReviewFinding,
  createUnmappedFinding,
} from "../../helpers/factories";

describe("mapFindingsToGitHubComments", () => {
  it("returns empty arrays when no findings", () => {
    const diff = createParsedDiff();
    const result = mapFindingsToGitHubComments([], diff);

    expect(result.mappedComments).toEqual([]);
    expect(result.unmappedFindings).toEqual([]);
  });

  it("maps finding to correct file path and line number", () => {
    const hunk = createDiffHunk({
      newStart: 1,
      lines: [
        createDiffLine({
          type: "added",
          content: "new code",
          newLineNumber: 2,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/test.ts", hunks: [hunk] })],
    });
    const finding = createReviewFinding({
      filePath: "src/test.ts",
      lineNumber: 2,
    });

    const result = mapFindingsToGitHubComments([finding], diff);

    expect(result.mappedComments).toHaveLength(1);
    expect(result.mappedComments[0]?.path).toBe("src/test.ts");
    expect(result.mappedComments[0]?.line).toBe(2);
  });

  it("sets side to RIGHT for added lines", () => {
    const hunk = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 5,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/a.ts", hunks: [hunk] })],
    });
    const finding = createReviewFinding({
      filePath: "src/a.ts",
      lineNumber: 5,
    });

    const result = mapFindingsToGitHubComments([finding], diff);
    expect(result.mappedComments[0]?.side).toBe("RIGHT");
  });

  it("sets side to LEFT for removed lines", () => {
    const hunk = createDiffHunk({
      lines: [
        createDiffLine({
          type: "removed",
          oldLineNumber: 3,
          newLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/a.ts", hunks: [hunk] })],
    });
    const finding = createReviewFinding({
      filePath: "src/a.ts",
      lineNumber: 3,
    });

    const result = mapFindingsToGitHubComments([finding], diff);
    expect(result.mappedComments[0]?.side).toBe("LEFT");
  });

  it("formats comment body with severity badge and category label", () => {
    const hunk = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 1,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/a.ts", hunks: [hunk] })],
    });
    const finding = createReviewFinding({
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "CRITICAL",
      category: "SECURITY",
      message: "Hardcoded secret",
    });

    const result = mapFindingsToGitHubComments([finding], diff);
    const body = result.mappedComments[0]?.formattedBody;
    expect(body).toContain("Critical");
    expect(body).toContain("Security");
    expect(body).toContain("Hardcoded secret");
  });

  it("includes suggestion in comment body when present", () => {
    const hunk = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 1,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/a.ts", hunks: [hunk] })],
    });
    const finding = createReviewFinding({
      filePath: "src/a.ts",
      lineNumber: 1,
      suggestion: "Use env variables instead",
    });

    const result = mapFindingsToGitHubComments([finding], diff);
    expect(result.mappedComments[0]?.formattedBody).toContain(
      "Use env variables instead",
    );
  });

  it("returns unmapped finding when file not found in diff", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/other.ts" })],
    });
    const finding = createReviewFinding({
      filePath: "src/missing.ts",
      lineNumber: 5,
    });

    const result = mapFindingsToGitHubComments([finding], diff);

    expect(result.mappedComments).toHaveLength(0);
    expect(result.unmappedFindings).toHaveLength(1);
    expect(result.unmappedFindings[0]?.reason).toContain("not found in diff");
  });

  it("returns unmapped finding when file has no hunks", () => {
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/empty.ts", hunks: [] })],
    });
    const finding = createReviewFinding({
      filePath: "src/empty.ts",
      lineNumber: 1,
    });

    const result = mapFindingsToGitHubComments([finding], diff);

    expect(result.unmappedFindings).toHaveLength(1);
    expect(result.unmappedFindings[0]?.reason).toContain("no reviewable hunks");
  });

  it("returns unmapped finding when line is outside diff context", () => {
    const hunk = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 1,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/a.ts", hunks: [hunk] })],
    });
    const finding = createReviewFinding({
      filePath: "src/a.ts",
      lineNumber: 999,
    });

    const result = mapFindingsToGitHubComments([finding], diff);

    expect(result.unmappedFindings).toHaveLength(1);
    expect(result.unmappedFindings[0]?.reason).toContain(
      "not within the diff context",
    );
  });

  it("matches finding to file by previousFilePath (renames)", () => {
    const hunk = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 1,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({
          filePath: "src/new-name.ts",
          previousFilePath: "src/old-name.ts",
          changeType: "renamed",
          hunks: [hunk],
        }),
      ],
    });
    const finding = createReviewFinding({
      filePath: "src/old-name.ts",
      lineNumber: 1,
    });

    const result = mapFindingsToGitHubComments([finding], diff);
    expect(result.mappedComments).toHaveLength(1);
    expect(result.mappedComments[0]?.path).toBe("src/new-name.ts");
  });

  it("maps multiple findings across multiple files", () => {
    const hunkA = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 1,
          oldLineNumber: null,
        }),
      ],
    });
    const hunkB = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 5,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [
        createParsedDiffFile({ filePath: "src/a.ts", hunks: [hunkA] }),
        createParsedDiffFile({ filePath: "src/b.ts", hunks: [hunkB] }),
      ],
    });
    const findings = [
      createReviewFinding({ filePath: "src/a.ts", lineNumber: 1 }),
      createReviewFinding({ filePath: "src/b.ts", lineNumber: 5 }),
    ];

    const result = mapFindingsToGitHubComments(findings, diff);
    expect(result.mappedComments).toHaveLength(2);
  });

  it("handles mixed mapped and unmapped findings", () => {
    const hunk = createDiffHunk({
      lines: [
        createDiffLine({
          type: "added",
          newLineNumber: 1,
          oldLineNumber: null,
        }),
      ],
    });
    const diff = createParsedDiff({
      files: [createParsedDiffFile({ filePath: "src/a.ts", hunks: [hunk] })],
    });
    const findings = [
      createReviewFinding({ filePath: "src/a.ts", lineNumber: 1 }),
      createReviewFinding({ filePath: "src/missing.ts", lineNumber: 10 }),
    ];

    const result = mapFindingsToGitHubComments(findings, diff);
    expect(result.mappedComments).toHaveLength(1);
    expect(result.unmappedFindings).toHaveLength(1);
  });
});

describe("buildReviewSummary", () => {
  it("returns summary with total count footer", () => {
    const summary = buildReviewSummary("Good review", 3, []);
    expect(summary).toContain("Good review");
    expect(summary).toContain("3 issues found");
    expect(summary).toContain("3 inline");
    expect(summary).toContain("0 in summary");
  });

  it("appends unmapped findings section when present", () => {
    const unmapped = [
      createUnmappedFinding({
        finding: createReviewFinding({
          filePath: "src/extra.ts",
          lineNumber: 42,
          message: "Extra issue outside diff",
        }),
      }),
    ];
    const summary = buildReviewSummary("Review done", 1, unmapped);

    expect(summary).toContain("Additional findings");
    expect(summary).toContain("src/extra.ts:42");
    expect(summary).toContain("Extra issue outside diff");
  });

  it("formats unmapped findings with severity badge and category", () => {
    const unmapped = [
      createUnmappedFinding({
        finding: createReviewFinding({
          severity: "WARNING",
          category: "BUGS",
        }),
      }),
    ];
    const summary = buildReviewSummary("Review", 0, unmapped);

    expect(summary).toContain("Warning");
    expect(summary).toContain("Bug Risk");
  });

  it("uses singular 'issue' for count of 1", () => {
    const summary = buildReviewSummary("Review", 1, []);
    expect(summary).toContain("1 issue found");
    expect(summary).not.toContain("1 issues");
  });

  it("uses plural 'issues' for count > 1", () => {
    const summary = buildReviewSummary("Review", 5, []);
    expect(summary).toContain("5 issues found");
  });

  it("shows inline and summary counts separately", () => {
    const unmapped = [createUnmappedFinding()];
    const summary = buildReviewSummary("Review", 2, unmapped);

    expect(summary).toContain("2 inline");
    expect(summary).toContain("1 in summary");
    expect(summary).toContain("3 issues found");
  });
});
