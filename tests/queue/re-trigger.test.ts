import { Queue, type Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import { createValkeyConnectionOptions } from "@/lib/queue/connection";
import { enqueueReviewJob } from "@/lib/queue/producer";
import { REVIEW_QUEUE_NAME } from "@/lib/queue/types";
import { executeReview } from "@/lib/review/engine";
import { err } from "@/types/results";
import { createReviewWorker } from "../../worker/review-worker";
import {
  createMockGitHubService,
  createMockLlmService,
} from "../helpers/factories";

// The producer enqueues on the real review queue; the review itself is
// stubbed at the engine.
vi.mock("@/lib/review/engine", () => ({ executeReview: vi.fn() }));
vi.mock("@/lib/github/api", () => ({ createGitHubServiceFromEnv: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({ createLlmClient: vi.fn() }));

const PAYLOAD = {
  installationId: 1001,
  githubRepoId: 2002,
  repositoryFullName: "octo-org/repo",
  pullRequestNumber: 7,
  commitSha: "a".repeat(40),
};

let queue: Queue;
let worker: Worker | undefined;

beforeEach(async () => {
  queue = new Queue(REVIEW_QUEUE_NAME, {
    connection: createValkeyConnectionOptions(),
  });
  await queue.obliterate({ force: true });
  vi.mocked(executeReview).mockReset();
  vi.mocked(createGitHubServiceFromEnv).mockReturnValue(
    createMockGitHubService(),
  );
  vi.mocked(createLlmClient).mockReturnValue(createMockLlmService());
});

afterEach(async () => {
  await worker?.close(true);
  await queue.obliterate({ force: true });
  await queue.close();
});

async function waitForReviewCalls(count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (vi.mocked(executeReview).mock.calls.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} review runs`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("re-triggering a review on real BullMQ and Valkey", () => {
  it("runs a re-trigger of a job that completed as a skip (#126)", async () => {
    // The repository was disabled when the pull request opened.
    vi.mocked(executeReview).mockResolvedValue(
      err("REVIEW_REPOSITORY_UNAVAILABLE"),
    );
    worker = createReviewWorker({
      connection: createValkeyConnectionOptions(),
      queueName: REVIEW_QUEUE_NAME,
      deadLetterQueue: queue,
      lockDurationMs: 30_000,
      stalledIntervalMs: 30_000,
    });

    const first = await enqueueReviewJob(PAYLOAD);
    await waitForReviewCalls(1);
    const firstJobId = first.success ? first.data.jobId : "";
    const deadline = Date.now() + 20_000;
    while ((await queue.getJobState(firstJobId)) !== "completed") {
      if (Date.now() > deadline) throw new Error("first job never completed");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // The admin enables the repository and reopens the pull request.
    const second = await enqueueReviewJob(PAYLOAD);

    expect(second).toEqual({ success: true, data: { jobId: firstJobId } });
    await waitForReviewCalls(2);
  });
});
