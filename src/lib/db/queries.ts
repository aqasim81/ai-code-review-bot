import { randomUUID } from "node:crypto";
import type {
  AccountType,
  InstallationStatus,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import type {
  CommentCategory,
  CommentSeverity,
  JobStatus,
  ReviewStatus,
} from "@/generated/prisma/enums";
import { describeError } from "@/lib/errors";
import type { AccessScope } from "@/types/access";
import type { InstallationId, RepositoryId, ReviewId } from "@/types/branded";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type { ReviewClaimRef } from "@/types/review";
import {
  mergeWithDefaults,
  type RepositorySettings,
  type RepositorySettingsInput,
} from "@/types/settings";
import { prisma } from "./prisma-client";

function databaseError(failurePrefix: string, error: unknown) {
  return err(
    `${failurePrefix}: ${describeError(error, "Unknown database error")}`,
  );
}

/** Runs a query and turns anything it throws into an error Result. */
async function runQuery<T>(
  failurePrefix: string,
  query: () => Promise<Result<T, string>>,
): Promise<Result<T, string>> {
  try {
    return await query();
  } catch (error) {
    return databaseError(failurePrefix, error);
  }
}

interface CreateInstallationInput {
  githubInstallationId: number;
  githubAccountLogin: string;
  githubAccountType: AccountType;
}

interface CreateRepositoryInput {
  githubRepoId: number;
  fullName: string;
}

async function saveInstallationRepositories(
  installation: CreateInstallationInput,
  repositories: readonly CreateRepositoryInput[],
  options: { readonly reactivate: boolean },
): Promise<InstallationId> {
  return prisma.$transaction(async (tx) => {
    const saved = await tx.installation.upsert({
      where: { githubInstallationId: installation.githubInstallationId },
      update: {
        githubAccountLogin: installation.githubAccountLogin,
        githubAccountType: installation.githubAccountType,
        ...(options.reactivate ? { status: "ACTIVE" as const } : {}),
      },
      create: { ...installation, status: "ACTIVE" },
    });
    for (const repo of repositories) {
      await tx.repository.upsert({
        where: {
          installationId_githubRepoId: {
            installationId: saved.id,
            githubRepoId: repo.githubRepoId,
          },
        },
        update: { fullName: repo.fullName, removedAt: null },
        create: { installationId: saved.id, ...repo },
      });
    }
    return saved.id as InstallationId;
  });
}

export async function createInstallationWithRepositories(
  installation: CreateInstallationInput,
  repositories: CreateRepositoryInput[],
): Promise<Result<{ id: InstallationId; repositoryCount: number }, string>> {
  return runQuery("Failed to save installation and repositories", async () => {
    const id = await saveInstallationRepositories(installation, repositories, {
      reactivate: true,
    });
    return ok({ id, repositoryCount: repositories.length });
  });
}

/**
 * Records repositories added to an installation. The installation is created
 * if it was never recorded, but its status is left alone: adding repositories
 * does not revive a suspended or deleted installation.
 */
export async function addRepositoriesToInstallation(
  installation: CreateInstallationInput,
  repositories: readonly CreateRepositoryInput[],
): Promise<Result<{ repositoryCount: number }, string>> {
  return runQuery("Failed to add repositories", async () => {
    await saveInstallationRepositories(installation, repositories, {
      reactivate: false,
    });
    return ok({ repositoryCount: repositories.length });
  });
}

/**
 * Marks repositories removed from an installation. Rows are kept rather than
 * deleted so a review job queued before the removal cannot recreate them;
 * adding the repository back clears the mark and keeps its settings.
 */
export async function removeRepositoriesFromInstallation(
  githubInstallationId: number,
  githubRepoIds: readonly number[],
): Promise<Result<{ removedCount: number }, string>> {
  return runQuery("Failed to remove repositories", async () => {
    const { count } = await prisma.repository.updateMany({
      where: {
        githubRepoId: { in: [...githubRepoIds] },
        installation: { githubInstallationId },
        removedAt: null,
      },
      data: { removedAt: new Date() },
    });
    return ok({ removedCount: count });
  });
}

/** Suspends or resumes an installation; a deleted installation stays deleted. */
export async function setInstallationSuspended(
  githubInstallationId: number,
  suspended: boolean,
): Promise<Result<void, string>> {
  return runQuery("Failed to update installation status", async () => {
    await prisma.installation.updateMany({
      where: { githubInstallationId, status: { not: "DELETED" } },
      data: { status: suspended ? "SUSPENDED" : "ACTIVE" },
    });
    return ok(undefined);
  });
}

// --- Review queries ---

interface RepositoryForReviewInput {
  readonly githubInstallationId: number;
  readonly githubRepoId: number;
  readonly fullName: string;
}

type RepositoryForReview = {
  id: RepositoryId;
  isEnabled: boolean;
  settings: Required<RepositorySettings>;
};

const REVIEW_REPOSITORY_SELECT = {
  id: true,
  isEnabled: true,
  fullName: true,
  removedAt: true,
  settings: true,
} as const;

/**
 * Finds the repository a review job is for by its GitHub ID under the job's
 * installation, so renames and old installations cannot mislead it. The
 * stored name follows GitHub's. A missing row is created: a signed
 * pull_request webhook proves the installation can see the repository.
 * Returns null when the installation is unknown or not active, or when the
 * repository was removed from the installation.
 */
export async function findOrCreateRepositoryForReview(
  input: RepositoryForReviewInput,
): Promise<Result<RepositoryForReview | null, string>> {
  return runQuery("Failed to find repository", async () => {
    const found = await prisma.repository.findFirst({
      where: {
        githubRepoId: input.githubRepoId,
        installation: { githubInstallationId: input.githubInstallationId },
      },
      select: {
        ...REVIEW_REPOSITORY_SELECT,
        installation: { select: { status: true } },
      },
    });
    if (found && found.installation.status !== "ACTIVE") return ok(null);

    const existing = found ?? (await createRepositoryForReview(input));
    if (!existing || existing.removedAt) return ok(null);

    if (existing.fullName !== input.fullName) {
      await prisma.repository.update({
        where: { id: existing.id },
        data: { fullName: input.fullName },
      });
    }
    return ok({
      id: existing.id as RepositoryId,
      isEnabled: existing.isEnabled,
      settings: mergeWithDefaults(existing.settings),
    });
  });
}

// Creates the row under an active installation, or returns null when the
// installation is unknown or not active. Two jobs for a repository without a
// row can race to create it; the loser reads the winner's row instead of
// failing.
async function createRepositoryForReview(input: RepositoryForReviewInput) {
  const installation = await prisma.installation.findUnique({
    where: { githubInstallationId: input.githubInstallationId },
    select: { id: true, status: true },
  });
  if (!installation || installation.status !== "ACTIVE") return null;

  try {
    return await prisma.repository.create({
      data: {
        installationId: installation.id,
        githubRepoId: input.githubRepoId,
        fullName: input.fullName,
      },
      select: REVIEW_REPOSITORY_SELECT,
    });
  } catch (error) {
    // throw-ok: findOrCreateRepositoryForReview catches it and returns a Result.
    if (!isUniqueConstraintViolation(error)) throw error;
    return prisma.repository.findUnique({
      where: {
        installationId_githubRepoId: {
          installationId: installation.id,
          githubRepoId: input.githubRepoId,
        },
      },
      select: REVIEW_REPOSITORY_SELECT,
    });
  }
}

/**
 * The head commit of the most recent completed review of a pull request, the
 * base a push review is diffed against. Null when no review completed.
 */
export async function findLastReviewedCommitSha(input: {
  readonly githubInstallationId: number;
  readonly githubRepoId: number;
  readonly pullRequestNumber: number;
}): Promise<Result<string | null, string>> {
  return runQuery("Failed to find the last reviewed commit", async () => {
    const review = await prisma.review.findFirst({
      where: {
        status: "COMPLETED",
        pullRequestNumber: input.pullRequestNumber,
        repository: {
          githubRepoId: input.githubRepoId,
          installation: { githubInstallationId: input.githubInstallationId },
        },
      },
      orderBy: [
        { completedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      select: { commitSha: true },
    });
    return ok(review?.commitSha ?? null);
  });
}

export async function findExistingReviewByCommitSha(
  repositoryId: RepositoryId,
  commitSha: string,
): Promise<Result<{ id: ReviewId; status: ReviewStatus } | null, string>> {
  return runQuery("Failed to check existing review", async () => {
    const review = await prisma.review.findUnique({
      where: { repositoryId_commitSha: { repositoryId, commitSha } },
      select: { id: true, status: true },
    });
    return ok(
      review ? { id: review.id as ReviewId, status: review.status } : null,
    );
  });
}

interface ClaimExistingReviewInput {
  readonly jobId: string;
  readonly pullRequestNumber: number;
  readonly staleBefore: Date;
}

/**
 * An unfinished review whose claim was last renewed before `staleBefore`: its
 * owner stopped working on it. Rows from before claims were recorded fall back
 * to `createdAt`.
 */
function staleReviewFilter(staleBefore: Date) {
  return {
    status: { in: ["PROCESSING" as const, "PENDING" as const] },
    OR: [
      { claimRenewedAt: { lt: staleBefore } },
      { claimRenewedAt: null, createdAt: { lt: staleBefore } },
    ],
  };
}

/**
 * Updates the review when it matches `where` and deletes its comments in the
 * same transaction. Returns false (and writes nothing) when it did not match.
 */
function updateReviewAndDropComments(
  reviewId: ReviewId,
  where: Prisma.ReviewWhereInput,
  data: Prisma.ReviewUpdateManyMutationInput,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.review.updateMany({ where, data });
    if (count === 0) return false;
    await tx.reviewComment.deleteMany({ where: { reviewId } });
    return true;
  });
}

const STALE_REVIEW_BATCH_SIZE = 100;

export async function findStaleReviewIds(
  staleBefore: Date,
): Promise<Result<ReviewId[], string>> {
  return runQuery("Failed to find stale reviews", async () => {
    const reviews = await prisma.review.findMany({
      where: staleReviewFilter(staleBefore),
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: STALE_REVIEW_BATCH_SIZE,
    });
    return ok(reviews.map((review) => review.id as ReviewId));
  });
}

/**
 * Marks a stale review FAILED, drops its unposted findings and clears its claim
 * token so an attempt that is somehow still running can no longer write.
 * Returns false when the review stopped being stale (it was reclaimed).
 */
export async function failStaleReview(
  reviewId: ReviewId,
  staleBefore: Date,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to expire stale review", async () => {
    const failed = await updateReviewAndDropComments(
      reviewId,
      { id: reviewId, ...staleReviewFilter(staleBefore) },
      {
        status: "FAILED",
        summary: "Review failed: timed out without finishing",
        issuesFound: 0,
        claimToken: null,
        completedAt: new Date(),
      },
    );
    return ok(failed);
  });
}

/**
 * Atomically claims an existing review for the given job and clears anything
 * left by the earlier attempt. A review can be claimed when it is FAILED or
 * SUPERSEDED (the pull request's head is back at its commit), when
 * it is PROCESSING under the same queue job (that attempt is no longer
 * running), or when it has been PROCESSING or PENDING since before
 * `staleBefore`. Returns null when another job still owns the review.
 */
export async function claimExistingReview(
  reviewId: ReviewId,
  claim: ClaimExistingReviewInput,
): Promise<Result<ReviewClaimRef | null, string>> {
  const claimToken = randomUUID();
  return runQuery("Failed to claim review", async () => {
    const claimed = await updateReviewAndDropComments(
      reviewId,
      {
        id: reviewId,
        OR: [
          { status: "FAILED" },
          { status: "SUPERSEDED" },
          { status: "PROCESSING", claimedByJobId: claim.jobId },
          staleReviewFilter(claim.staleBefore),
        ],
      },
      {
        status: "PROCESSING",
        claimedByJobId: claim.jobId,
        claimToken,
        claimRenewedAt: new Date(),
        pullRequestNumber: claim.pullRequestNumber,
        summary: null,
        issuesFound: 0,
        processingTimeMs: null,
        completedAt: null,
      },
    );
    return ok(claimed ? { reviewId, claimToken } : null);
  });
}

interface CreateReviewInput {
  repositoryId: RepositoryId;
  pullRequestNumber: number;
  commitSha: string;
  claimedByJobId: string;
}

// For reviews, the only unique key an insert can hit is (repositoryId,
// commitSha); the id is a random UUID. The pg adapter does not fill
// `meta.target`, so the error code is the reliable signal.
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Creates a PROCESSING review claimed by the given job. Returns null when a
 * review for the same repository and commit already exists, i.e. another job
 * created it first.
 */
export async function createReviewRecord(
  input: CreateReviewInput,
): Promise<Result<ReviewClaimRef | null, string>> {
  const claimToken = randomUUID();
  try {
    const review = await prisma.review.create({
      data: {
        repositoryId: input.repositoryId,
        pullRequestNumber: input.pullRequestNumber,
        commitSha: input.commitSha,
        status: "PROCESSING",
        claimedByJobId: input.claimedByJobId,
        claimToken,
        claimRenewedAt: new Date(),
      },
    });
    return ok({ reviewId: review.id as ReviewId, claimToken });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return ok(null);
    return databaseError("Failed to create review record", error);
  }
}

interface SaveReviewCommentInput {
  filePath: string;
  lineNumber: number;
  category: CommentCategory;
  severity: CommentSeverity;
  message: string;
  suggestion: string | null;
  confidence: number;
  githubCommentId: string | null;
}

interface SaveReviewFindingsInput extends ReviewClaimRef {
  summary: string;
  issuesFound: number;
  comments: SaveReviewCommentInput[];
}

/** Matches the review only while this attempt's claim is still current. */
function currentClaimFilter(claim: ReviewClaimRef) {
  return {
    id: claim.reviewId,
    claimToken: claim.claimToken,
    status: "PROCESSING" as const,
  };
}

/**
 * Saves the findings and summary; the review stays PROCESSING until posted.
 * Returns false (and writes nothing) when the claim was lost.
 */
export async function saveReviewFindings(
  input: SaveReviewFindingsInput,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to save review results", async () => {
    const saved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.review.updateMany({
        where: currentClaimFilter(input),
        data: { summary: input.summary, issuesFound: input.issuesFound },
      });
      if (count === 0) return false;
      await tx.reviewComment.createMany({
        data: input.comments.map((comment) => ({
          ...comment,
          reviewId: input.reviewId,
        })),
      });
      return true;
    });
    return ok(saved);
  });
}

export async function isReviewClaimCurrent(
  claim: ReviewClaimRef,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to check review claim", async () => {
    const count = await prisma.review.count({
      where: currentClaimFilter(claim),
    });
    return ok(count > 0);
  });
}

/**
 * Records that the attempt holding the claim is still working, so the review
 * does not become stale. Returns false (and writes nothing) when the claim was
 * lost.
 */
export async function renewReviewClaim(
  claim: ReviewClaimRef,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to renew review claim", async () => {
    const { count } = await prisma.review.updateMany({
      where: currentClaimFilter(claim),
      data: { claimRenewedAt: new Date() },
    });
    return ok(count > 0);
  });
}

/** Returns false (and writes nothing) when the claim was lost. */
export async function markReviewCompleted(
  claim: ReviewClaimRef,
  processingTimeMs: number,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to mark review completed", async () => {
    const { count } = await prisma.review.updateMany({
      where: currentClaimFilter(claim),
      data: { status: "COMPLETED", processingTimeMs, completedAt: new Date() },
    });
    return ok(count > 0);
  });
}

/**
 * Marks a review SUPERSEDED: newer pushes replaced its commit before it was
 * posted. Its findings are dropped since they never reached GitHub, and it is
 * not a base for later push reviews. Returns false (and writes nothing) when
 * the claim was lost.
 */
export async function markReviewSuperseded(
  claim: ReviewClaimRef,
  summary: string,
  processingTimeMs: number,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to mark review superseded", async () => {
    const superseded = await updateReviewAndDropComments(
      claim.reviewId,
      currentClaimFilter(claim),
      {
        status: "SUPERSEDED",
        summary,
        issuesFound: 0,
        processingTimeMs,
        completedAt: new Date(),
      },
    );
    return ok(superseded);
  });
}

/**
 * Marks a review FAILED and drops any findings saved before the failure, since
 * they may never have been posted to GitHub. Returns false (and writes
 * nothing) when the claim was lost.
 */
export async function failReview(
  claim: ReviewClaimRef,
  errorMessage: string,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to mark review as failed", async () => {
    const failed = await updateReviewAndDropComments(
      claim.reviewId,
      currentClaimFilter(claim),
      {
        status: "FAILED",
        summary: `Review failed: ${errorMessage}`,
        issuesFound: 0,
        completedAt: new Date(),
      },
    );
    return ok(failed);
  });
}

// --- Job queries (Phase 4: Background Processing) ---

interface CreateJobRecordInput {
  type: "review-pr" | "review-pr-delta";
  payload: Record<string, string | number | boolean>;
  initialStatus?: "QUEUED" | "PROCESSING";
}

/**
 * The job record a run of a queue job owns. Every run claims the record with
 * a new token; status writes only apply while the token is still current.
 */
export interface JobRecordRun {
  readonly id: string;
  readonly runToken: string;
}

export async function createJobRecord(
  input: CreateJobRecordInput,
): Promise<Result<JobRecordRun, string>> {
  const runToken = randomUUID();
  return runQuery("Failed to create job record", async () => {
    const job = await prisma.job.create({
      data: {
        type: input.type,
        payload: input.payload,
        status: input.initialStatus ?? "QUEUED",
        runToken,
        runRenewedAt: new Date(),
      },
    });
    return ok({ id: job.id, runToken });
  });
}

/**
 * Hands the job record to a new run of its queue job: PROCESSING with a new
 * run token. An earlier run that is still going (it lost its queue lock) can
 * no longer write. Returns null when the record no longer exists.
 */
export async function claimJobRecord(
  id: string,
): Promise<Result<JobRecordRun | null, string>> {
  const runToken = randomUUID();
  return runQuery("Failed to claim job record", async () => {
    const { count } = await prisma.job.updateMany({
      where: { id },
      data: {
        status: "PROCESSING",
        runToken,
        runRenewedAt: new Date(),
        processedAt: null,
      },
    });
    return ok(count > 0 ? { id, runToken } : null);
  });
}

/**
 * Sets the status while `run` still owns the record. Returns false (and
 * writes nothing) when a later run claimed it or it was closed as failed.
 */
export async function updateJobRecord(
  run: JobRecordRun,
  status: JobStatus,
  details?: { lastError?: string; attempts?: number },
): Promise<Result<boolean, string>> {
  return runQuery("Failed to update job record", async () => {
    const { count } = await prisma.job.updateMany({
      where: { id: run.id, runToken: run.runToken },
      data: {
        status,
        lastError: details?.lastError,
        attempts: details?.attempts,
        processedAt:
          status === "COMPLETED" || status === "FAILED"
            ? new Date()
            : undefined,
      },
    });
    return ok(count > 0);
  });
}

const UNFINISHED_JOB_STATUSES: JobStatus[] = ["QUEUED", "PROCESSING"];

/**
 * Records that `run` is still working on the job, so the sweep does not take
 * the record for an abandoned one. Returns false (and writes nothing) when
 * the run no longer owns the record or it already has a final status.
 */
export async function renewJobRecord(
  run: JobRecordRun,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to renew job record", async () => {
    const { count } = await prisma.job.updateMany({
      where: {
        id: run.id,
        runToken: run.runToken,
        status: { in: UNFINISHED_JOB_STATUSES },
      },
      data: { runRenewedAt: new Date() },
    });
    return ok(count > 0);
  });
}

/**
 * An unfinished job record whose run last renewed it before `renewedBefore`.
 * A record without a renewal time was written by a worker that predates
 * renewals and may still be running it, so it is never matched.
 */
function abandonedJobRecordFilter(renewedBefore: Date) {
  return {
    status: { in: UNFINISHED_JOB_STATUSES },
    runRenewedAt: { lt: renewedBefore },
  };
}

const ABANDONED_JOB_RECORD_BATCH_SIZE = 100;

export async function findAbandonedJobRecordIds(
  renewedBefore: Date,
): Promise<Result<string[], string>> {
  return runQuery("Failed to find abandoned job records", async () => {
    const jobs = await prisma.job.findMany({
      where: abandonedJobRecordFilter(renewedBefore),
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: ABANDONED_JOB_RECORD_BATCH_SIZE,
    });
    return ok(jobs.map((job) => job.id));
  });
}

/**
 * Marks an abandoned job record FAILED and clears its run token, so a run
 * that is somehow still going can no longer write. Returns false when the
 * record stopped being abandoned (it was renewed, claimed or finished).
 */
export async function failAbandonedJobRecord(
  id: string,
  renewedBefore: Date,
): Promise<Result<boolean, string>> {
  return runQuery("Failed to expire abandoned job record", async () => {
    const { count } = await prisma.job.updateMany({
      where: { id, ...abandonedJobRecordFilter(renewedBefore) },
      data: {
        status: "FAILED",
        lastError: "JOB_RECORD_ABANDONED",
        runToken: null,
        processedAt: new Date(),
      },
    });
    return ok(count > 0);
  });
}

/**
 * Marks a job record FAILED unless it already has a final status, and clears
 * its run token so a run that is somehow still going can no longer write.
 * Returns false when it was already COMPLETED or FAILED.
 */
export async function failUnfinishedJobRecord(
  id: string,
  details: { lastError: string; attempts: number },
): Promise<Result<boolean, string>> {
  return runQuery(
    "Failed to mark unfinished job record as failed",
    async () => {
      const { count } = await prisma.job.updateMany({
        where: { id, status: { in: UNFINISHED_JOB_STATUSES } },
        data: {
          status: "FAILED",
          lastError: details.lastError,
          attempts: details.attempts,
          runToken: null,
          processedAt: new Date(),
        },
      });
      return ok(count > 0);
    },
  );
}

// --- Dashboard queries (Phase 5: Dashboard UI) ---

interface InstallationRecord {
  readonly id: InstallationId;
  readonly githubInstallationId: number;
  readonly githubAccountLogin: string;
  readonly githubAccountType: AccountType;
  readonly status: InstallationStatus;
}

export async function findInstallationsByGitHubIds(
  githubInstallationIds: readonly number[],
): Promise<Result<readonly InstallationRecord[], string>> {
  return runQuery("Failed to find installations", async () => {
    const installations = await prisma.installation.findMany({
      where: {
        githubInstallationId: { in: [...githubInstallationIds] },
        status: "ACTIVE",
      },
      select: {
        id: true,
        githubInstallationId: true,
        githubAccountLogin: true,
        githubAccountType: true,
        status: true,
      },
      orderBy: [{ githubAccountLogin: "asc" }, { githubInstallationId: "asc" }],
    });
    return ok(
      installations.map((i) => ({
        ...i,
        id: i.id as InstallationId,
      })),
    );
  });
}

// Repositories the user may see: ones GitHub reported as accessible, under an
// active installation GitHub reported for the user. Empty lists match nothing.
function repositoryInScopeWhere(
  scope: AccessScope,
  githubRepoIds: readonly number[] = scope.accessibleGithubRepoIds,
): Prisma.RepositoryWhereInput {
  return {
    githubRepoId: { in: [...githubRepoIds] },
    removedAt: null,
    installation: {
      githubInstallationId: { in: [...scope.githubInstallationIds] },
      status: "ACTIVE",
    },
  };
}

interface RepositoryListItem {
  readonly id: RepositoryId;
  readonly githubRepoId: number;
  readonly installationId: InstallationId;
  readonly fullName: string;
  readonly isEnabled: boolean;
}

export async function listRepositoriesInScope(
  scope: AccessScope,
): Promise<Result<readonly RepositoryListItem[], string>> {
  return runQuery("Failed to list repositories", async () => {
    const repositories = await prisma.repository.findMany({
      where: repositoryInScopeWhere(scope),
      select: {
        id: true,
        githubRepoId: true,
        installationId: true,
        fullName: true,
        isEnabled: true,
      },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
    });
    return ok(
      repositories.map((r) => ({
        ...r,
        id: r.id as RepositoryId,
        installationId: r.installationId as InstallationId,
      })),
    );
  });
}

interface RepositoryDetail {
  readonly id: RepositoryId;
  readonly githubRepoId: number;
  readonly fullName: string;
  readonly settings: unknown;
}

export async function findAccessibleRepositoryById(
  repositoryId: RepositoryId,
  scope: AccessScope,
): Promise<Result<RepositoryDetail | null, string>> {
  return runQuery("Failed to find repository", async () => {
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId, ...repositoryInScopeWhere(scope) },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        settings: true,
      },
    });
    if (!repo) return ok(null);
    return ok({ ...repo, id: repo.id as RepositoryId });
  });
}

function updateManageableRepository(
  repositoryId: RepositoryId,
  scope: AccessScope,
  data: Prisma.RepositoryUpdateManyMutationInput,
  failurePrefix: string,
): Promise<Result<boolean, string>> {
  return runQuery(failurePrefix, async () => {
    const { count } = await prisma.repository.updateMany({
      where: {
        id: repositoryId,
        ...repositoryInScopeWhere(scope, scope.manageableGithubRepoIds),
      },
      data,
    });
    return ok(count > 0);
  });
}

/**
 * Updates the repository only when the user can manage it. Returns false when
 * no repository matched, so the caller can refuse without a separate check
 * racing the write.
 */
export async function updateRepositoryEnabled(
  repositoryId: RepositoryId,
  isEnabled: boolean,
  scope: AccessScope,
): Promise<Result<boolean, string>> {
  return updateManageableRepository(
    repositoryId,
    scope,
    { isEnabled },
    "Failed to update repository",
  );
}

export async function updateRepositorySettings(
  repositoryId: RepositoryId,
  settings: RepositorySettingsInput,
  scope: AccessScope,
): Promise<Result<boolean, string>> {
  return updateManageableRepository(
    repositoryId,
    scope,
    { settings: JSON.parse(JSON.stringify(settings)) },
    "Failed to update repository settings",
  );
}

interface ListReviewsInput {
  readonly scope: AccessScope;
  readonly repositoryId?: RepositoryId;
  readonly status?: ReviewStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReviewListItem {
  readonly id: ReviewId;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly commitSha: string;
  readonly status: ReviewStatus;
  readonly issuesFound: number;
  readonly processingTimeMs: number | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

const REVIEW_SUMMARY_SELECT = {
  id: true,
  pullRequestNumber: true,
  commitSha: true,
  status: true,
  issuesFound: true,
  processingTimeMs: true,
  createdAt: true,
  completedAt: true,
  repository: { select: { fullName: true } },
} as const;

function toReviewListItem(
  review: Prisma.ReviewGetPayload<{ select: typeof REVIEW_SUMMARY_SELECT }>,
): ReviewListItem {
  const { repository, ...fields } = review;
  return {
    ...fields,
    id: review.id as ReviewId,
    repositoryFullName: repository.fullName,
  };
}

export async function listReviewsInScope(
  input: ListReviewsInput,
): Promise<
  Result<
    { reviews: readonly ReviewListItem[]; nextCursor: string | null },
    string
  >
> {
  const limit = input.limit ?? 20;
  const repository = repositoryInScopeWhere(input.scope);

  return runQuery("Failed to list reviews", async () => {
    // Prisma locates the cursor row without the where filter, so a cursor
    // outside the scope would reveal where that review sits in time.
    if (input.cursor) {
      const cursorReview = await prisma.review.findFirst({
        where: { id: input.cursor, repository },
        select: { id: true },
      });
      if (!cursorReview) return ok({ reviews: [], nextCursor: null });
    }

    const reviews = await prisma.review.findMany({
      where: {
        repository: {
          ...repository,
          ...(input.repositoryId ? { id: input.repositoryId } : {}),
        },
        ...(input.status ? { status: input.status } : {}),
      },
      select: REVIEW_SUMMARY_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return ok({
      reviews: items.map(toReviewListItem),
      nextCursor,
    });
  });
}

export interface ReviewDetailResult extends ReviewListItem {
  readonly summary: string | null;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly filePath: string;
    readonly lineNumber: number;
    readonly category: CommentCategory;
    readonly severity: CommentSeverity;
    readonly message: string;
    readonly suggestion: string | null;
    readonly confidence: number;
  }>;
}

export async function getReviewWithCommentsInScope(
  reviewId: ReviewId,
  scope: AccessScope,
): Promise<Result<ReviewDetailResult | null, string>> {
  return runQuery("Failed to get review details", async () => {
    const review = await prisma.review.findFirst({
      where: {
        id: reviewId,
        repository: repositoryInScopeWhere(scope),
      },
      select: {
        ...REVIEW_SUMMARY_SELECT,
        summary: true,
        comments: {
          select: {
            id: true,
            filePath: true,
            lineNumber: true,
            category: true,
            severity: true,
            message: true,
            suggestion: true,
            confidence: true,
          },
          orderBy: [{ filePath: "asc" }, { lineNumber: "asc" }],
        },
      },
    });

    if (!review) return ok(null);

    const { summary, comments, ...listFields } = review;
    return ok({ ...toReviewListItem(listFields), summary, comments });
  });
}

interface ReviewStatsResult {
  readonly totalReviews: number;
  readonly totalIssuesFound: number;
  readonly categoryBreakdown: ReadonlyArray<{
    category: CommentCategory;
    count: number;
  }>;
  readonly recentReviewCount: number;
}

export async function getReviewStatsInScope(
  scope: AccessScope,
): Promise<Result<ReviewStatsResult, string>> {
  return runQuery("Failed to get review stats", async () => {
    const repository = repositoryInScopeWhere(scope);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [totals, recentCount, categoryGroups] = await Promise.all([
      prisma.review.aggregate({
        where: { repository },
        _count: { _all: true },
        _sum: { issuesFound: true },
      }),
      prisma.review.count({
        where: { repository, createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.reviewComment.groupBy({
        by: ["category"],
        orderBy: { category: "asc" },
        where: { review: { repository } },
        _count: { _all: true },
      }),
    ]);

    return ok({
      totalReviews: totals._count._all,
      totalIssuesFound: totals._sum.issuesFound ?? 0,
      recentReviewCount: recentCount,
      categoryBreakdown: categoryGroups.map((g) => ({
        category: g.category,
        count: g._count._all,
      })),
    });
  });
}

export async function markInstallationDeleted(
  githubInstallationId: number,
): Promise<Result<void, string>> {
  return runQuery("Failed to mark installation as deleted", async () => {
    await prisma.installation.updateMany({
      where: { githubInstallationId },
      data: { status: "DELETED" },
    });
    return ok(undefined);
  });
}
