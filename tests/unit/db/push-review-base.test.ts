import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({ review: { findFirst: vi.fn() } }));

vi.mock("@/lib/db/prisma-client", () => ({ prisma: prismaMock }));

import { findPushReviewBase } from "@/lib/db/queries";

const INPUT = {
  githubInstallationId: 12345,
  githubRepoId: 555,
  pullRequestNumber: 42,
};

describe("findPushReviewBase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the completed review of the newest reviewed commit of the pull request", async () => {
    const base = {
      commitSha: "abc",
      coveredFilePaths: ["src/a.ts"],
      settingsFingerprint: "fingerprint",
    };
    prismaMock.review.findFirst.mockResolvedValue(base);

    const result = await findPushReviewBase(INPUT);

    expect(result).toEqual({ success: true, data: base });
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
        { headSeenAt: { sort: "desc", nulls: "last" } },
        { completedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      select: {
        commitSha: true,
        coveredFilePaths: true,
        settingsFingerprint: true,
      },
    });
  });

  it("returns null when no review of the pull request completed", async () => {
    prismaMock.review.findFirst.mockResolvedValue(null);

    expect(await findPushReviewBase(INPUT)).toEqual({
      success: true,
      data: null,
    });
  });

  it("returns an error when the database fails", async () => {
    prismaMock.review.findFirst.mockRejectedValue(new Error("down"));

    expect(await findPushReviewBase(INPUT)).toEqual({
      success: false,
      error: "Failed to find the last reviewed commit: down",
    });
  });
});
