import type {
  AccountType,
  InstallationStatus,
} from "@/generated/prisma/client";
import type {
  CommentCategory,
  CommentSeverity,
  JobStatus,
  ReviewStatus,
} from "@/generated/prisma/enums";
import type { InstallationId, RepositoryId, ReviewId } from "@/types/branded";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type { RepositorySettingsInput } from "@/types/settings";
import { prisma } from "./prisma-client";

interface CreateInstallationInput {
  githubInstallationId: number;
  githubAccountLogin: string;
  githubAccountType: AccountType;
}

interface CreateRepositoryInput {
  githubRepoId: number;
  fullName: string;
}

export async function createInstallationWithRepositories(
  installation: CreateInstallationInput,
  repositories: CreateRepositoryInput[],
): Promise<Result<{ id: InstallationId; repositoryCount: number }, string>> {
  try {
    const id = await prisma.$transaction(async (tx) => {
      const saved = await tx.installation.upsert({
        where: { githubInstallationId: installation.githubInstallationId },
        update: {
          githubAccountLogin: installation.githubAccountLogin,
          githubAccountType: installation.githubAccountType,
          status: "ACTIVE",
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
          update: { fullName: repo.fullName },
          create: { installationId: saved.id, ...repo },
        });
      }
      return saved.id as InstallationId;
    });
    return ok({ id, repositoryCount: repositories.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to save installation and repositories: ${message}`);
  }
}

// --- Review queries ---

export async function findRepositoryByFullName(
  fullName: string,
): Promise<
  Result<{ id: RepositoryId; installationId: InstallationId } | null, string>
> {
  try {
    const repo = await prisma.repository.findFirst({
      where: { fullName, isEnabled: true },
      select: { id: true, installationId: true },
    });
    if (!repo) return ok(null);
    return ok({
      id: repo.id as RepositoryId,
      installationId: repo.installationId as InstallationId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to find repository: ${message}`);
  }
}

export async function findExistingReviewByCommitSha(
  repositoryId: RepositoryId,
  commitSha: string,
): Promise<Result<{ id: ReviewId; status: ReviewStatus } | null, string>> {
  try {
    const review = await prisma.review.findUnique({
      where: { repositoryId_commitSha: { repositoryId, commitSha } },
      select: { id: true, status: true },
    });
    return ok(
      review ? { id: review.id as ReviewId, status: review.status } : null,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to check existing review: ${message}`);
  }
}

/**
 * Claims a FAILED review for a retry: moves it back to PROCESSING under the
 * retrying job's pull request and clears any comments left by the failed
 * attempt. Returns false when the review is no longer FAILED (another job
 * already claimed it).
 */
export async function resetFailedReviewForRetry(
  reviewId: ReviewId,
  pullRequestNumber: number,
): Promise<Result<boolean, string>> {
  try {
    const claimed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.review.updateMany({
        where: { id: reviewId, status: "FAILED" },
        data: {
          status: "PROCESSING",
          pullRequestNumber,
          summary: null,
          issuesFound: 0,
          processingTimeMs: null,
          completedAt: null,
        },
      });
      if (count === 0) return false;
      await tx.reviewComment.deleteMany({ where: { reviewId } });
      return true;
    });
    return ok(claimed);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to reset review for retry: ${message}`);
  }
}

interface CreateReviewInput {
  repositoryId: RepositoryId;
  pullRequestNumber: number;
  commitSha: string;
}

export async function createReviewRecord(
  input: CreateReviewInput,
): Promise<Result<{ id: ReviewId }, string>> {
  try {
    const review = await prisma.review.create({
      data: {
        repositoryId: input.repositoryId,
        pullRequestNumber: input.pullRequestNumber,
        commitSha: input.commitSha,
        status: "PROCESSING",
      },
    });
    return ok({ id: review.id as ReviewId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to create review record: ${message}`);
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

interface SaveReviewFindingsInput {
  reviewId: ReviewId;
  summary: string;
  issuesFound: number;
  comments: SaveReviewCommentInput[];
}

/** Saves the findings and summary; the review stays PROCESSING until posted. */
export async function saveReviewFindings(
  input: SaveReviewFindingsInput,
): Promise<Result<void, string>> {
  try {
    await prisma.$transaction([
      prisma.reviewComment.createMany({
        data: input.comments.map((comment) => ({
          ...comment,
          reviewId: input.reviewId,
        })),
      }),
      prisma.review.update({
        where: { id: input.reviewId },
        data: { summary: input.summary, issuesFound: input.issuesFound },
      }),
    ]);
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to save review results: ${message}`);
  }
}

export async function markReviewCompleted(
  reviewId: ReviewId,
  processingTimeMs: number,
): Promise<Result<void, string>> {
  try {
    await prisma.review.update({
      where: { id: reviewId },
      data: { status: "COMPLETED", processingTimeMs, completedAt: new Date() },
    });
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to mark review completed: ${message}`);
  }
}

/**
 * Marks a review FAILED and drops any findings saved before the failure, since
 * they may never have been posted to GitHub.
 */
export async function failReview(
  reviewId: ReviewId,
  errorMessage: string,
): Promise<Result<void, string>> {
  try {
    await prisma.$transaction([
      prisma.reviewComment.deleteMany({ where: { reviewId } }),
      prisma.review.update({
        where: { id: reviewId },
        data: {
          status: "FAILED",
          summary: `Review failed: ${errorMessage}`,
          issuesFound: 0,
          completedAt: new Date(),
        },
      }),
    ]);
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to mark review as failed: ${message}`);
  }
}

// --- Job queries (Phase 4: Background Processing) ---

interface CreateJobRecordInput {
  type: "review-pr" | "review-pr-delta";
  payload: Record<string, string | number | boolean>;
  initialStatus?: "QUEUED" | "PROCESSING";
}

export async function createJobRecord(
  input: CreateJobRecordInput,
): Promise<Result<{ id: string }, string>> {
  try {
    const job = await prisma.job.create({
      data: {
        type: input.type,
        payload: input.payload,
        status: input.initialStatus ?? "QUEUED",
      },
    });
    return ok({ id: job.id });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to create job record: ${message}`);
  }
}

export async function updateJobRecord(
  id: string,
  status: JobStatus,
  details?: { lastError?: string; attempts?: number },
): Promise<Result<void, string>> {
  try {
    await prisma.job.update({
      where: { id },
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
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to update job record: ${message}`);
  }
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
  try {
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
    });
    return ok(
      installations.map((i) => ({
        ...i,
        id: i.id as InstallationId,
      })),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to find installations: ${message}`);
  }
}

interface RepositoryListItem {
  readonly id: RepositoryId;
  readonly fullName: string;
  readonly isEnabled: boolean;
  readonly settings: unknown;
  readonly createdAt: Date;
}

export async function listRepositoriesForInstallation(
  installationId: InstallationId,
): Promise<Result<readonly RepositoryListItem[], string>> {
  try {
    const repositories = await prisma.repository.findMany({
      where: { installationId },
      select: {
        id: true,
        fullName: true,
        isEnabled: true,
        settings: true,
        createdAt: true,
      },
      orderBy: { fullName: "asc" },
    });
    return ok(
      repositories.map((r) => ({
        ...r,
        id: r.id as RepositoryId,
      })),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to list repositories: ${message}`);
  }
}

interface RepositoryDetail {
  readonly id: RepositoryId;
  readonly fullName: string;
  readonly isEnabled: boolean;
  readonly settings: unknown;
  readonly installationId: InstallationId;
}

export async function findRepositoryByIdForInstallations(
  repositoryId: RepositoryId,
  installationIds: readonly InstallationId[],
): Promise<Result<RepositoryDetail | null, string>> {
  try {
    const repo = await prisma.repository.findFirst({
      where: {
        id: repositoryId,
        installationId: { in: [...installationIds] },
      },
      select: {
        id: true,
        fullName: true,
        isEnabled: true,
        settings: true,
        installationId: true,
      },
    });
    if (!repo) return ok(null);
    return ok({
      ...repo,
      id: repo.id as RepositoryId,
      installationId: repo.installationId as InstallationId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to find repository: ${message}`);
  }
}

export async function updateRepositoryEnabled(
  repositoryId: RepositoryId,
  isEnabled: boolean,
): Promise<Result<void, string>> {
  try {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { isEnabled },
    });
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to update repository: ${message}`);
  }
}

export async function updateRepositorySettings(
  repositoryId: RepositoryId,
  settings: RepositorySettingsInput,
): Promise<Result<void, string>> {
  try {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: JSON.parse(JSON.stringify(settings)) },
    });
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to update repository settings: ${message}`);
  }
}

interface ListReviewsInput {
  readonly installationId: InstallationId;
  readonly repositoryId?: RepositoryId;
  readonly status?: ReviewStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

interface ReviewListItem {
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

export async function listReviewsForInstallation(
  input: ListReviewsInput,
): Promise<
  Result<
    { reviews: readonly ReviewListItem[]; nextCursor: string | null },
    string
  >
> {
  const limit = input.limit ?? 20;

  try {
    const reviews = await prisma.review.findMany({
      where: {
        repository: {
          installationId: input.installationId,
          ...(input.repositoryId ? { id: input.repositoryId } : {}),
        },
        ...(input.status ? { status: input.status } : {}),
      },
      select: {
        id: true,
        pullRequestNumber: true,
        commitSha: true,
        status: true,
        issuesFound: true,
        processingTimeMs: true,
        createdAt: true,
        completedAt: true,
        repository: { select: { fullName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    const hasMore = reviews.length > limit;
    const items = hasMore ? reviews.slice(0, limit) : reviews;
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return ok({
      reviews: items.map((r) => ({
        id: r.id as ReviewId,
        repositoryFullName: r.repository.fullName,
        pullRequestNumber: r.pullRequestNumber,
        commitSha: r.commitSha,
        status: r.status,
        issuesFound: r.issuesFound,
        processingTimeMs: r.processingTimeMs,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
      nextCursor,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to list reviews: ${message}`);
  }
}

interface ReviewDetailResult {
  readonly id: ReviewId;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly commitSha: string;
  readonly status: ReviewStatus;
  readonly summary: string | null;
  readonly issuesFound: number;
  readonly processingTimeMs: number | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
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

export async function getReviewWithCommentsForInstallations(
  reviewId: ReviewId,
  installationIds: readonly InstallationId[],
): Promise<Result<ReviewDetailResult | null, string>> {
  try {
    const review = await prisma.review.findFirst({
      where: {
        id: reviewId,
        repository: { installationId: { in: [...installationIds] } },
      },
      select: {
        id: true,
        pullRequestNumber: true,
        commitSha: true,
        status: true,
        summary: true,
        issuesFound: true,
        processingTimeMs: true,
        createdAt: true,
        completedAt: true,
        repository: { select: { fullName: true } },
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

    return ok({
      id: review.id as ReviewId,
      repositoryFullName: review.repository.fullName,
      pullRequestNumber: review.pullRequestNumber,
      commitSha: review.commitSha,
      status: review.status,
      summary: review.summary,
      issuesFound: review.issuesFound,
      processingTimeMs: review.processingTimeMs,
      createdAt: review.createdAt,
      completedAt: review.completedAt,
      comments: review.comments,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to get review details: ${message}`);
  }
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

export async function getReviewStatsForInstallation(
  installationId: InstallationId,
): Promise<Result<ReviewStatsResult, string>> {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [totalReviews, issueSum, recentCount, categoryGroups] =
      await prisma.$transaction([
        prisma.review.count({
          where: { repository: { installationId } },
        }),
        prisma.review.aggregate({
          where: { repository: { installationId } },
          _sum: { issuesFound: true },
        }),
        prisma.review.count({
          where: {
            repository: { installationId },
            createdAt: { gte: thirtyDaysAgo },
          },
        }),
        prisma.reviewComment.groupBy({
          by: ["category"],
          orderBy: { category: "asc" },
          where: { review: { repository: { installationId } } },
          _count: { _all: true },
        }),
      ]);

    return ok({
      totalReviews,
      totalIssuesFound: issueSum._sum.issuesFound ?? 0,
      recentReviewCount: recentCount,
      categoryBreakdown: categoryGroups.map((g) => {
        const countValue = g._count;
        const count =
          typeof countValue === "number"
            ? countValue
            : typeof countValue === "object" &&
                countValue !== null &&
                "_all" in countValue
              ? (countValue._all as number)
              : 0;
        return { category: g.category, count };
      }),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to get review stats: ${message}`);
  }
}

export async function markInstallationDeleted(
  githubInstallationId: number,
): Promise<Result<void, string>> {
  try {
    await prisma.installation.updateMany({
      where: { githubInstallationId },
      data: { status: "DELETED" },
    });
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to mark installation as deleted: ${message}`);
  }
}
