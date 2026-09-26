export const REVIEW_QUEUE_NAME = "review-jobs" as const;
export const DEAD_LETTER_QUEUE_NAME = "review-jobs-dead-letter" as const;

export interface ReviewJobPayload {
  readonly installationId: number;
  readonly githubRepoId: number;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly commitSha: string;
  /**
   * When GitHub reported the event (the pull request's `updated_at`, ISO
   * 8601). A redelivery keeps the original time. Absent on jobs queued before
   * it was added.
   */
  readonly eventAt?: string;
}

export type ReviewJobData =
  | {
      readonly type: "review-pr";
      readonly payload: ReviewJobPayload;
      readonly dbJobId?: string;
    }
  | {
      readonly type: "review-pr-delta";
      readonly payload: ReviewJobPayload;
      readonly dbJobId?: string;
    };
