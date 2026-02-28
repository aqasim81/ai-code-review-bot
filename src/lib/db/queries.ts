import type { AccountType } from "@/generated/prisma/client";
import type {
  CommentCategory,
  CommentSeverity,
  ReviewStatus,
} from "@/generated/prisma/enums";
import type { InstallationId, RepositoryId, ReviewId } from "@/types/branded";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import { prisma } from "./prisma-client";

interface CreateInstallationInput {
  githubInstallationId: number;
  githubAccountLogin: string;
  githubAccountType: AccountType;
}

export async function createInstallation(
  input: CreateInstallationInput,
): Promise<Result<{ id: InstallationId }, string>> {
  try {
    const installation = await prisma.installation.upsert({
      where: { githubInstallationId: input.githubInstallationId },
      update: {
        githubAccountLogin: input.githubAccountLogin,
        githubAccountType: input.githubAccountType,
        status: "ACTIVE",
      },
      create: {
        githubInstallationId: input.githubInstallationId,
        githubAccountLogin: input.githubAccountLogin,
        githubAccountType: input.githubAccountType,
        status: "ACTIVE",
      },
    });
    return ok({ id: installation.id as InstallationId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to create installation: ${message}`);
  }
}

interface CreateRepositoryInput {
  githubRepoId: number;
  fullName: string;
}

export async function createRepositories(
  installationId: InstallationId,
  repositories: CreateRepositoryInput[],
): Promise<Result<{ count: number }, string>> {
  try {
    const results = await prisma.$transaction(
      repositories.map((repo) =>
        prisma.repository.upsert({
          where: {
            installationId_githubRepoId: {
              installationId,
              githubRepoId: repo.githubRepoId,
            },
          },
          update: {
            fullName: repo.fullName,
          },
          create: {
            installationId,
            githubRepoId: repo.githubRepoId,
            fullName: repo.fullName,
          },
        }),
      ),
    );
    return ok({ count: results.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to create repositories: ${message}`);
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
): Promise<Result<{ id: ReviewId } | null, string>> {
  try {
    const review = await prisma.review.findUnique({
      where: { repositoryId_commitSha: { repositoryId, commitSha } },
      select: { id: true },
    });
    return ok(review ? { id: review.id as ReviewId } : null);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to check existing review: ${message}`);
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
        status: "PENDING",
      },
    });
    return ok({ id: review.id as ReviewId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to create review record: ${message}`);
  }
}

export async function updateReviewStatus(
  reviewId: ReviewId,
  status: ReviewStatus,
): Promise<Result<void, string>> {
  try {
    await prisma.review.update({
      where: { id: reviewId },
      data: { status },
    });
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to update review status: ${message}`);
  }
}

interface SaveReviewCommentInput {
  reviewId: ReviewId;
  filePath: string;
  lineNumber: number;
  category: CommentCategory;
  severity: CommentSeverity;
  message: string;
  suggestion: string | null;
  confidence: number;
  githubCommentId: string | null;
}

export async function saveReviewComments(
  comments: SaveReviewCommentInput[],
): Promise<Result<{ count: number }, string>> {
  if (comments.length === 0) {
    return ok({ count: 0 });
  }

  try {
    const result = await prisma.reviewComment.createMany({
      data: comments.map((comment) => ({
        reviewId: comment.reviewId,
        filePath: comment.filePath,
        lineNumber: comment.lineNumber,
        category: comment.category,
        severity: comment.severity,
        message: comment.message,
        suggestion: comment.suggestion,
        confidence: comment.confidence,
        githubCommentId: comment.githubCommentId,
      })),
    });
    return ok({ count: result.count });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to save review comments: ${message}`);
  }
}

interface CompleteReviewInput {
  reviewId: ReviewId;
  summary: string;
  issuesFound: number;
  processingTimeMs: number;
}

export async function completeReview(
  input: CompleteReviewInput,
): Promise<Result<void, string>> {
  try {
    await prisma.review.update({
      where: { id: input.reviewId },
      data: {
        status: "COMPLETED",
        summary: input.summary,
        issuesFound: input.issuesFound,
        processingTimeMs: input.processingTimeMs,
        completedAt: new Date(),
      },
    });
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to complete review: ${message}`);
  }
}

export async function failReview(
  reviewId: ReviewId,
  errorMessage: string,
): Promise<Result<void, string>> {
  try {
    await prisma.review.update({
      where: { id: reviewId },
      data: {
        status: "FAILED",
        summary: `Review failed: ${errorMessage}`,
        completedAt: new Date(),
      },
    });
    return ok(undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to mark review as failed: ${message}`);
  }
}
