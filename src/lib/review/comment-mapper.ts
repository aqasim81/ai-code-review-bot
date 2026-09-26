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

/**
 * The longest body posted to GitHub. GitHub rejects a review or comment body
 * over 65,536 characters with 422 ("Body is too long (maximum is 65536
 * characters)"; https://github.com/orgs/community/discussions/27190), which
 * would fail the whole review (#122); GitHub stores a body in 262,144 bytes.
 * The margin leaves room for the review marker appended when posting. Counted
 * in UTF-16 units, 60,000 is at most 60,000 characters and at most 180,000
 * UTF-8 bytes, so a body within it fits however GitHub counts.
 */
const MAX_POSTED_BODY_LENGTH = 60_000;

/** Longest message of one finding listed in the review summary. */
const MAX_SUMMARY_MESSAGE_LENGTH = 1_000;

const TRUNCATION_NOTE = "… (truncated)";

/**
 * Shortens text to at most `maxLength` UTF-16 units, ending with a note, and
 * never splits a surrogate pair.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = Math.max(0, maxLength - TRUNCATION_NOTE.length);
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${TRUNCATION_NOTE}`;
}

function formatFindingHeading(finding: ReviewFinding): string {
  return `${SEVERITY_BADGES[finding.severity]} | ${CATEGORY_LABELS[finding.category]}`;
}

function formatCommentBody(finding: ReviewFinding): string {
  const heading = `${formatFindingHeading(finding)}\n\n`;
  const textBudget = MAX_POSTED_BODY_LENGTH - heading.length;
  if (!finding.suggestion) {
    return `${heading}${truncateText(finding.message, textBudget)}`;
  }

  const suggestionLabel = "\n\n**Suggestion:** ";
  const sharedBudget = textBudget - suggestionLabel.length;
  // The suggestion keeps up to half the room; the message takes the rest.
  const message = truncateText(
    finding.message,
    sharedBudget -
      Math.min(finding.suggestion.length, Math.floor(sharedBudget / 2)),
  );
  const suggestion = truncateText(
    finding.suggestion,
    sharedBudget - message.length,
  );
  return `${heading}${message}${suggestionLabel}${suggestion}`;
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

function formatSummaryLine({ finding }: UnmappedFinding): string {
  const location = truncateText(
    `${finding.filePath}:${finding.lineNumber}`,
    MAX_SUMMARY_MESSAGE_LENGTH,
  );
  const message = truncateText(finding.message, MAX_SUMMARY_MESSAGE_LENGTH);
  return `\n- ${formatFindingHeading(finding)} — \`${location}\`: ${message}`;
}

// Long enough for "…and 1234567 more findings not listed here." after the
// last line that fits.
const OMITTED_LINE_RESERVE = 100;

/**
 * Lists the findings outside the diff until the next one would not fit in
 * `budget`, then says how many were left out.
 */
function formatAdditionalFindings(
  unmappedFindings: readonly UnmappedFinding[],
  budget: number,
): string {
  let section = "\n\n---\n\n**Additional findings** (outside diff context):\n";
  const lineBudget = budget - OMITTED_LINE_RESERVE;
  let listed = 0;
  for (const unmapped of unmappedFindings) {
    const line = formatSummaryLine(unmapped);
    if (section.length + line.length > lineBudget) break;
    section += line;
    listed++;
  }
  const omitted = unmappedFindings.length - listed;
  if (omitted > 0) {
    section += `\n\n…and ${omitted} more finding${omitted === 1 ? "" : "s"} not listed here.`;
  }
  return section;
}

/** The review body, within the length GitHub accepts (#122). */
export function buildReviewSummary(
  summaryText: string,
  mappedCount: number,
  unmappedFindings: readonly UnmappedFinding[],
): string {
  const totalFindings = mappedCount + unmappedFindings.length;
  const footer = `\n\n---\n*${totalFindings} issue${totalFindings === 1 ? "" : "s"} found (${mappedCount} inline, ${unmappedFindings.length} in summary)*`;
  const summary = truncateText(
    summaryText,
    Math.floor(MAX_POSTED_BODY_LENGTH / 4),
  );
  const additionalFindings =
    unmappedFindings.length > 0
      ? formatAdditionalFindings(
          unmappedFindings,
          MAX_POSTED_BODY_LENGTH - summary.length - footer.length,
        )
      : "";
  return `${summary}${additionalFindings}${footer}`;
}
