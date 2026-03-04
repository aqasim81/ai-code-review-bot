export const REVIEW_QUEUE_NAME = "review-jobs" as const;
export const DEAD_LETTER_QUEUE_NAME = "review-jobs-dead-letter" as const;

export interface ReviewJobPayload {
  readonly installationId: number;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly commitSha: string;
}

export interface DeltaReviewJobPayload extends ReviewJobPayload {
  readonly previousCommitSha: string;
}

export type ReviewJobData =
  | {
      readonly type: "review-pr";
      readonly payload: ReviewJobPayload;
      readonly dbJobId?: string;
    }
  | {
      readonly type: "review-pr-delta";
      readonly payload: DeltaReviewJobPayload;
      readonly dbJobId?: string;
    };
