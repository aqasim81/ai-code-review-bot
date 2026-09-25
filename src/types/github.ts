import type { GitHubError } from "@/types/errors";
import type { Result } from "@/types/results";

interface GitHubReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

export interface PullRequestReviewPayload {
  readonly commitSha: string;
  readonly body: string;
  readonly event: "COMMENT" | "REQUEST_CHANGES";
  readonly comments: readonly GitHubReviewComment[];
}

export interface PostedReviewResult {
  readonly githubReviewId: number;
  readonly postedCommentCount: number;
}

export type CommitComparisonFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

interface CommitComparisonFile {
  readonly filename: string;
  readonly status: CommitComparisonFileStatus;
}

export interface CommitComparisonResult {
  /** How head relates to base: only "ahead" means head builds on base. */
  readonly status: "ahead" | "behind" | "identical" | "diverged";
  readonly files: readonly CommitComparisonFile[];
}

export interface GitHubService {
  fetchPullRequestDiff(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<Result<string, GitHubError>>;

  fetchFileContent(
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
  ): Promise<Result<string, GitHubError>>;

  postPullRequestReview(
    owner: string,
    repo: string,
    pullNumber: number,
    review: PullRequestReviewPayload,
  ): Promise<Result<PostedReviewResult, GitHubError>>;

  /** The SHA of the pull request's current head commit. */
  fetchPullRequestHeadSha(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<Result<string, GitHubError>>;

  /** Finds this bot's review on the PR carrying `marker`, if one was posted. */
  findPostedReview(
    owner: string,
    repo: string,
    pullNumber: number,
    marker: string,
  ): Promise<Result<{ githubReviewId: number } | null, GitHubError>>;

  compareCommits(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<Result<CommitComparisonResult, GitHubError>>;
}
