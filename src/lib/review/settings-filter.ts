import picomatch from "picomatch";
import type { CommentSeverity } from "@/generated/prisma/enums";
import type { ReviewFinding } from "@/types/review";
import type { RepositorySettings } from "@/types/settings";

const SEVERITY_RANK = {
  CRITICAL: 4,
  WARNING: 3,
  SUGGESTION: 2,
  NITPICK: 1,
} as const satisfies Record<CommentSeverity, number>;

// A pattern without a slash matches the file name in any directory, so
// "*.lock" excludes nested lock files too, as the settings form promises.
// picomatch's basename option applies to every pattern once set, which would
// stop "dist/**" matching anything, so it is chosen per pattern. A leading "!"
// would invert the pattern and exclude every other file, so it is literal.
function excludePatternOptions(pattern: string): picomatch.PicomatchOptions {
  return { dot: true, nonegate: true, basename: !pattern.includes("/") };
}

/**
 * Builds a check for the repository's exclude patterns (globs against the
 * path from the repository root). picomatch throws only for an empty pattern,
 * which is dropped here, or one far longer than settings allow.
 */
export function createExcludedPathMatcher(
  patterns: readonly string[],
): (filePath: string) => boolean {
  const matchers = patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => picomatch(pattern, excludePatternOptions(pattern)));

  return (filePath) => matchers.some((matches) => matches(filePath));
}

/**
 * Keeps the findings the repository asked for: an enabled category, and a
 * severity at or above the minimum.
 */
export function filterFindingsBySettings(
  findings: readonly ReviewFinding[],
  settings: Required<RepositorySettings>,
): readonly ReviewFinding[] {
  const minimumRank = SEVERITY_RANK[settings.minimumSeverity];
  return findings.filter(
    (finding) =>
      settings.enabledCategories.includes(finding.category) &&
      SEVERITY_RANK[finding.severity] >= minimumRank,
  );
}
