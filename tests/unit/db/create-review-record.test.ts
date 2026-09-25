import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/prisma-client", () => ({
  prisma: { review: { create: reviewCreate } },
}));

import { Prisma } from "@/generated/prisma/client";
import { createReviewRecord } from "@/lib/db/queries";
import type { RepositoryId } from "@/types/branded";

const INPUT = {
  repositoryId: "repo-1" as RepositoryId,
  pullRequestNumber: 42,
  commitSha: "abc123",
  claimedByJobId: "job-1",
};

function knownRequestError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("database error", {
    code,
    clientVersion: "7",
  });
}

describe("createReviewRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the new review's claim", async () => {
    reviewCreate.mockResolvedValue({ id: "review-1" });

    const result = await createReviewRecord(INPUT);

    expect(result).toEqual({
      success: true,
      data: { reviewId: "review-1", claimToken: expect.any(String) },
    });
  });

  it("returns null when another job already created the review (unique violation)", async () => {
    reviewCreate.mockRejectedValue(knownRequestError("P2002"));

    const result = await createReviewRecord(INPUT);

    expect(result).toEqual({ success: true, data: null });
  });

  it("still returns an error for other database failures", async () => {
    reviewCreate.mockRejectedValue(knownRequestError("P2003"));

    const result = await createReviewRecord(INPUT);

    expect(result.success).toBe(false);
  });
});
