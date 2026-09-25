import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({ review: { findFirst: vi.fn() } }));

vi.mock("@/lib/db/prisma-client", () => ({ prisma: prismaMock }));

import { findLastReviewedCommitSha } from "@/lib/db/queries";

const INPUT = {
  githubInstallationId: 12345,
  githubRepoId: 555,
  pullRequestNumber: 42,
};

describe("findLastReviewedCommitSha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the commit of the most recent completed review of the pull request", async () => {
    prismaMock.review.findFirst.mockResolvedValue({ commitSha: "abc" });

    const result = await findLastReviewedCommitSha(INPUT);

    expect(result).toEqual({ success: true, data: "abc" });
    expect(prismaMock.review.findFirst).toHaveBeenCalledWith({
      where: {
        status: "COMPLETED",
        pullRequestNumber: 42,
        repository: {
          githubRepoId: 555,
          installation: { githubInstallationId: 12345 },
        },
      },
      orderBy: [
        { completedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      select: { commitSha: true },
    });
  });

  it("returns null when no review of the pull request completed", async () => {
    prismaMock.review.findFirst.mockResolvedValue(null);

    expect(await findLastReviewedCommitSha(INPUT)).toEqual({
      success: true,
      data: null,
    });
  });

  it("returns an error when the database fails", async () => {
    prismaMock.review.findFirst.mockRejectedValue(new Error("down"));

    expect(await findLastReviewedCommitSha(INPUT)).toEqual({
      success: false,
      error: "Failed to find the last reviewed commit: down",
    });
  });
});
