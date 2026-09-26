import type { PushReviewBase } from "@/types/review";

/**
 * The files of the pull request a push review looks at: those changed since
 * the base review, and those the base review did not cover (a chunk that
 * failed, a file brought in by a base-branch change, one an exclude pattern
 * kept out). Null means the whole pull request: there is no base, or the
 * settings that shape findings changed since it ran.
 */
export function selectPushReviewScope(
  pullRequestFilePaths: readonly string[],
  base: PushReviewBase | undefined,
  settingsFingerprint: string,
): ReadonlySet<string> | null {
  if (base === undefined || base.settingsFingerprint !== settingsFingerprint) {
    return null;
  }
  const changed = new Set(base.changedFilePaths);
  const covered = new Set(base.coveredFilePaths);
  return new Set(
    pullRequestFilePaths.filter(
      (filePath) => changed.has(filePath) || !covered.has(filePath),
    ),
  );
}
