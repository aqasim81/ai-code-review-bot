import type { GitHubError } from "@/types/errors";
import type { Result } from "@/types/results";

export interface GitHubReviewComment {
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
}
