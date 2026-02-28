import type {
  CommentCategory,
  CommentSeverity,
} from "@/generated/prisma/enums";
import type {
  CommentMappingResult,
  DiffHunk,
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

function formatCommentBody(finding: ReviewFinding): string {
  const badge = SEVERITY_BADGES[finding.severity] ?? finding.severity;
  const category = CATEGORY_LABELS[finding.category] ?? finding.category;

  let body = `${badge} | ${category}\n\n${finding.message}`;

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

function findLineInHunk(
  hunk: DiffHunk,
  lineNumber: number,
): { line: DiffLine; side: "LEFT" | "RIGHT" } | undefined {
  for (const line of hunk.lines) {
    if (line.newLineNumber === lineNumber) {
      const side = line.type === "removed" ? "LEFT" : "RIGHT";
      return { line, side };
    }
    if (line.type === "removed" && line.oldLineNumber === lineNumber) {
      return { line, side: "LEFT" };
    }
  }
  return undefined;
}

function findLineInFile(
  diffFile: ParsedDiffFile,
  lineNumber: number,
): { hunk: DiffHunk; line: DiffLine; side: "LEFT" | "RIGHT" } | undefined {
  for (const hunk of diffFile.hunks) {
    const match = findLineInHunk(hunk, lineNumber);
    if (match) {
      return { hunk, ...match };
    }
  }
  return undefined;
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

  const lineMatch = findLineInFile(diffFile, finding.lineNumber);

  if (!lineMatch) {
    return {
      finding,
      reason: `Line ${finding.lineNumber} in "${finding.filePath}" is not within the diff context`,
    };
  }

  const lineNumber =
    lineMatch.side === "LEFT"
      ? (lineMatch.line.oldLineNumber ?? finding.lineNumber)
      : (lineMatch.line.newLineNumber ?? finding.lineNumber);

  return {
    finding,
    path: diffFile.filePath,
    line: lineNumber,
    side: lineMatch.side,
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
  if (findings.length === 0) {
    return { mappedComments: [], unmappedFindings: [] };
  }

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
  llmSummary: string,
  mappedCount: number,
  unmappedFindings: readonly UnmappedFinding[],
): string {
  let summary = llmSummary;

  if (unmappedFindings.length > 0) {
    summary += "\n\n---\n\n**Additional findings** (outside diff context):\n";
    for (const { finding } of unmappedFindings) {
      const badge = SEVERITY_BADGES[finding.severity] ?? finding.severity;
      const category = CATEGORY_LABELS[finding.category] ?? finding.category;
      summary += `\n- ${badge} | ${category} — \`${finding.filePath}:${finding.lineNumber}\`: ${finding.message}`;
    }
  }

  const totalFindings = mappedCount + unmappedFindings.length;
  summary += `\n\n---\n*${totalFindings} issue${totalFindings === 1 ? "" : "s"} found (${mappedCount} inline, ${unmappedFindings.length} in summary)*`;

  return summary;
}
