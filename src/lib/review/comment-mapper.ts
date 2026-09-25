import type {
  CommentCategory,
  CommentSeverity,
} from "@/generated/prisma/enums";
import type {
  CommentMappingResult,
  DiffLine,
  MappedReviewComment,
  ParsedDiff,
  ParsedDiffFile,
  ReviewFinding,
  UnmappedFinding,
} from "@/types/review";

const SEVERITY_BADGES: Record<CommentSeverity, string> = {
  CRITICAL: "🔴 **Critical**",
  WARNING: "🟡 **Warning**",
  SUGGESTION: "🔵 **Suggestion**",
  NITPICK: "⚪ **Nitpick**",
};

const CATEGORY_LABELS: Record<CommentCategory, string> = {
  SECURITY: "Security",
  BUGS: "Bug Risk",
  PERFORMANCE: "Performance",
  STYLE: "Style",
  BEST_PRACTICES: "Best Practices",
};

function formatFindingHeading(finding: ReviewFinding): string {
  return `${SEVERITY_BADGES[finding.severity]} | ${CATEGORY_LABELS[finding.category]}`;
}

function formatCommentBody(finding: ReviewFinding): string {
  let body = `${formatFindingHeading(finding)}\n\n${finding.message}`;

  if (finding.suggestion) {
    body += `\n\n**Suggestion:** ${finding.suggestion}`;
  }

  return body;
}

function findFileInDiff(
  parsedDiff: ParsedDiff,
  filePath: string,
): ParsedDiffFile | undefined {
  return parsedDiff.files.find(
    (file) => file.filePath === filePath || file.previousFilePath === filePath,
  );
}

type DiffSide = "LEFT" | "RIGHT";

function findLineWhere(
  diffFile: ParsedDiffFile,
  matches: (line: DiffLine) => boolean,
  side: DiffSide,
): DiffSide | undefined {
  return diffFile.hunks.some((hunk) => hunk.lines.some(matches))
    ? side
    : undefined;
}

/**
 * The side of the diff the finding's line is on. Findings use new-file line
 * numbers, so a line that exists in the new file (added or context) wins
 * anywhere in the file. A removed line is matched by its old line number only
 * when no new-file line has that number; otherwise a finding on a changed line
 * would land on the deleted code it replaced. Either way the line number the
 * comment is posted on is the finding's own.
 */
function findSideOfLine(
  diffFile: ParsedDiffFile,
  lineNumber: number,
): DiffSide | undefined {
  return (
    findLineWhere(
      diffFile,
      (line) => line.newLineNumber === lineNumber,
      "RIGHT",
    ) ??
    findLineWhere(
      diffFile,
      (line) => line.type === "removed" && line.oldLineNumber === lineNumber,
      "LEFT",
    )
  );
}

function mapSingleFinding(
  finding: ReviewFinding,
  parsedDiff: ParsedDiff,
): MappedReviewComment | UnmappedFinding {
  const diffFile = findFileInDiff(parsedDiff, finding.filePath);

  if (!diffFile) {
    return {
      finding,
      reason: `File "${finding.filePath}" not found in diff`,
    };
  }

  if (diffFile.hunks.length === 0) {
    return {
      finding,
      reason: `File "${finding.filePath}" has no reviewable hunks`,
    };
  }

  const side = findSideOfLine(diffFile, finding.lineNumber);

  if (!side) {
    return {
      finding,
      reason: `Line ${finding.lineNumber} in "${finding.filePath}" is not within the diff context`,
    };
  }

  return {
    finding,
    path: diffFile.filePath,
    line: finding.lineNumber,
    side,
    formattedBody: formatCommentBody(finding),
  };
}

function isMappedComment(
  result: MappedReviewComment | UnmappedFinding,
): result is MappedReviewComment {
  return "path" in result;
}

export function mapFindingsToGitHubComments(
  findings: readonly ReviewFinding[],
  parsedDiff: ParsedDiff,
): CommentMappingResult {
  const results = findings.map((finding) =>
    mapSingleFinding(finding, parsedDiff),
  );

  const mappedComments = results.filter(isMappedComment);
  const unmappedFindings = results.filter(
    (r): r is UnmappedFinding => !isMappedComment(r),
  );

  return { mappedComments, unmappedFindings };
}

export function buildReviewSummary(
  summaryText: string,
  mappedCount: number,
  unmappedFindings: readonly UnmappedFinding[],
): string {
  let summary = summaryText;

  if (unmappedFindings.length > 0) {
    summary += "\n\n---\n\n**Additional findings** (outside diff context):\n";
    for (const { finding } of unmappedFindings) {
      summary += `\n- ${formatFindingHeading(finding)} — \`${finding.filePath}:${finding.lineNumber}\`: ${finding.message}`;
    }
  }

  const totalFindings = mappedCount + unmappedFindings.length;
  summary += `\n\n---\n*${totalFindings} issue${totalFindings === 1 ? "" : "s"} found (${mappedCount} inline, ${unmappedFindings.length} in summary)*`;

  return summary;
}
