import { describe, expect, it } from "vitest";
import { createReviewRecord, saveReviewFindings } from "@/lib/db/queries";
import { parseLlmReviewResponse } from "@/lib/llm/parser";
import type { ReviewClaimRef, ReviewFinding } from "@/types/review";
import { createActiveRepository, testPrisma } from "./database";

async function claimNewReview(): Promise<ReviewClaimRef> {
  const repositoryId = await createActiveRepository();
  const created = await createReviewRecord({
    repositoryId,
    pullRequestNumber: 7,
    commitSha: "abc123",
    claimedByJobId: "job-1",
  });
  if (!created.success || created.data === null) {
    throw new Error("could not create the review");
  }
  return created.data;
}

function finding(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    filePath: "src/a.ts",
    lineNumber: 3,
    category: "BUGS",
    severity: "WARNING",
    message: "Possible null dereference",
    suggestion: "Check for null first.",
    confidence: 0.9,
    ...overrides,
  };
}

// The model's reply goes through the parser and is saved the way the review
// engine saves it, so what Postgres rejects is checked on the real path.
async function parseAndSave(
  claim: ReviewClaimRef,
  reply: readonly Record<string, unknown>[],
) {
  const parsed = parseLlmReviewResponse(JSON.stringify(reply));
  if (!parsed.success) throw new Error(parsed.error);
  const findings: readonly ReviewFinding[] = parsed.data;
  return saveReviewFindings({
    ...claim,
    summary: "Summary",
    issuesFound: findings.length,
    comments: findings.map((f) => ({
      filePath: f.filePath,
      lineNumber: f.lineNumber,
      category: f.category,
      severity: f.severity,
      message: f.message,
      suggestion: f.suggestion,
      confidence: f.confidence,
      githubCommentId: null,
    })),
  });
}

describe("saving model findings in Postgres", () => {
  it("saves a finding whose message and suggestion contain NUL (#67)", async () => {
    const claim = await claimNewReview();

    const saved = await parseAndSave(claim, [
      finding({ message: "bad\u0000byte", suggestion: "strip\u0000it" }),
    ]);

    expect(saved).toEqual({ success: true, data: true });
    const comments = await testPrisma.reviewComment.findMany();
    expect(comments.map((c) => [c.message, c.suggestion])).toEqual([
      ["badbyte", "stripit"],
    ]);
  });

  it("drops a finding whose line number is outside Postgres integer range and saves the rest (#55)", async () => {
    const claim = await claimNewReview();

    const saved = await parseAndSave(claim, [
      finding({ lineNumber: 2 ** 31, message: "too far" }),
      finding({ lineNumber: 4, message: "kept" }),
    ]);

    expect(saved).toEqual({ success: true, data: true });
    const comments = await testPrisma.reviewComment.findMany();
    expect(comments.map((c) => [c.lineNumber, c.message])).toEqual([
      [4, "kept"],
    ]);
  });
});
