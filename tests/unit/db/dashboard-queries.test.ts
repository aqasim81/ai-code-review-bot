import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  installation: { findMany: vi.fn() },
  repository: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  review: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
  },
  reviewComment: { groupBy: vi.fn() },
}));

vi.mock("@/lib/db/prisma-client", () => ({ prisma: prismaMock }));

import {
  findAccessibleRepositoryById,
  findInstallationsByGitHubIds,
  getReviewStatsInScope,
  getReviewWithCommentsInScope,
  listRepositoriesInScope,
  listReviewsInScope,
  updateRepositoryEnabled,
  updateRepositorySettings,
} from "@/lib/db/queries";
import type { AccessScope } from "@/types/access";
import type { RepositoryId, ReviewId } from "@/types/branded";

const SCOPE: AccessScope = {
  githubInstallationIds: [10],
  accessibleGithubRepoIds: [1, 2],
  manageableGithubRepoIds: [1],
};

const IN_SCOPE = {
  githubRepoId: { in: [1, 2] },
  removedAt: null,
  installation: { githubInstallationId: { in: [10] }, status: "ACTIVE" },
};

const MANAGEABLE = {
  githubRepoId: { in: [1] },
  removedAt: null,
  installation: { githubInstallationId: { in: [10] }, status: "ACTIVE" },
};

const REPO_ID = "repo-1" as RepositoryId;

function whereOf(mock: ReturnType<typeof vi.fn>): unknown {
  return mock.mock.calls[0]?.[0]?.where;
}

describe("dashboard queries are limited to the user's access scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.installation.findMany.mockResolvedValue([]);
    prismaMock.repository.findMany.mockResolvedValue([]);
    prismaMock.repository.findFirst.mockResolvedValue(null);
    prismaMock.repository.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.review.findMany.mockResolvedValue([]);
    prismaMock.review.findFirst.mockResolvedValue(null);
    prismaMock.review.count.mockResolvedValue(0);
    prismaMock.review.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _sum: { issuesFound: 0 },
    });
    prismaMock.reviewComment.groupBy.mockResolvedValue([]);
  });

  it("orders installations so the same one never comes first at random", async () => {
    await findInstallationsByGitHubIds([10, 20]);

    expect(
      prismaMock.installation.findMany.mock.calls[0]?.[0]?.orderBy,
    ).toEqual([{ githubAccountLogin: "asc" }, { githubInstallationId: "asc" }]);
  });

  it("lists only accessible repositories across all of the user's installations", async () => {
    await listRepositoriesInScope(SCOPE);

    expect(whereOf(prismaMock.repository.findMany)).toEqual(IN_SCOPE);
  });

  it("matches nothing when the scope is empty", async () => {
    await listRepositoriesInScope({
      githubInstallationIds: [],
      accessibleGithubRepoIds: [],
      manageableGithubRepoIds: [],
    });

    expect(whereOf(prismaMock.repository.findMany)).toEqual({
      githubRepoId: { in: [] },
      removedAt: null,
      installation: { githubInstallationId: { in: [] }, status: "ACTIVE" },
    });
  });

  it("finds a repository by ID only inside the scope", async () => {
    await findAccessibleRepositoryById(REPO_ID, SCOPE);

    expect(whereOf(prismaMock.repository.findFirst)).toEqual({
      id: REPO_ID,
      ...IN_SCOPE,
    });
  });

  it("updates a repository only when the user can manage it", async () => {
    prismaMock.repository.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await updateRepositoryEnabled(REPO_ID, false, SCOPE);

    expect(whereOf(prismaMock.repository.updateMany)).toEqual({
      id: REPO_ID,
      ...MANAGEABLE,
    });
    expect(result).toEqual({ success: true, data: false });
  });

  it("saves settings only when the user can manage the repository", async () => {
    const result = await updateRepositorySettings(
      REPO_ID,
      {
        enabledCategories: ["BUGS"],
        minimumSeverity: "WARNING",
        excludePatterns: [],
        customInstructions: "",
      },
      SCOPE,
    );

    expect(whereOf(prismaMock.repository.updateMany)).toEqual({
      id: REPO_ID,
      ...MANAGEABLE,
    });
    expect(result).toEqual({ success: true, data: true });
  });

  it("lists reviews inside the scope with a stable order", async () => {
    await listReviewsInScope({ scope: SCOPE, repositoryId: REPO_ID });

    const args = prismaMock.review.findMany.mock.calls[0]?.[0];
    expect(args?.where).toEqual({ repository: { ...IN_SCOPE, id: REPO_ID } });
    expect(args?.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("returns an empty page for a cursor outside the scope", async () => {
    prismaMock.review.findFirst.mockResolvedValueOnce(null);

    const result = await listReviewsInScope({
      scope: SCOPE,
      cursor: "other-review",
    });

    expect(whereOf(prismaMock.review.findFirst)).toEqual({
      id: "other-review",
      repository: IN_SCOPE,
    });
    expect(prismaMock.review.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: { reviews: [], nextCursor: null },
    });
  });

  it("pages from a cursor inside the scope", async () => {
    prismaMock.review.findFirst.mockResolvedValueOnce({ id: "own-review" });

    await listReviewsInScope({ scope: SCOPE, cursor: "own-review" });

    const args = prismaMock.review.findMany.mock.calls[0]?.[0];
    expect(args?.cursor).toEqual({ id: "own-review" });
    expect(args?.skip).toBe(1);
  });

  it("loads a review's details only inside the scope", async () => {
    await getReviewWithCommentsInScope("review-1" as ReviewId, SCOPE);

    expect(whereOf(prismaMock.review.findFirst)).toEqual({
      id: "review-1",
      repository: IN_SCOPE,
    });
  });

  it("computes every statistic inside the scope", async () => {
    await getReviewStatsInScope(SCOPE);

    for (const call of prismaMock.review.count.mock.calls) {
      expect(call[0]?.where?.repository).toEqual(IN_SCOPE);
    }
    expect(prismaMock.review.count).toHaveBeenCalledTimes(1);
    expect(whereOf(prismaMock.review.aggregate)).toEqual({
      repository: IN_SCOPE,
    });
    expect(whereOf(prismaMock.reviewComment.groupBy)).toEqual({
      review: { repository: IN_SCOPE },
    });
  });
});
