import { randomUUID } from "node:crypto";
import { Queue, type Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { createLlmClient } from "@/lib/llm/client";
import { createValkeyConnectionOptions } from "@/lib/queue/connection";
import { calculateBackoffDelay } from "@/lib/queue/processor";
import { REVIEW_JOB_OPTIONS } from "@/lib/queue/producer";
import type { ReviewJobData } from "@/lib/queue/types";
import { executeReview } from "@/lib/review/engine";
import type { ReviewEngineError } from "@/types/errors";
import { err, ok } from "@/types/results";
import type { ReviewRequest } from "@/types/review";
import { createReviewWorker } from "../../worker/review-worker";
import { testPrisma } from "../db/database";
import {
  createMockGitHubService,
  createMockLlmService,
  createReviewEngineResult,
} from "../helpers/factories";

// The review itself is stubbed at the engine; everything around it is real:
// BullMQ on Valkey, the processor, the worker's handlers and the job records
// in Postgres.
vi.mock("@/lib/review/engine", () => ({ executeReview: vi.fn() }));
vi.mock("@/lib/github/api", () => ({ createGitHubServiceFromEnv: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({ createLlmClient: vi.fn() }));

// The real strategy waits 10s and 30s between attempts; the retry test only
// needs to see what BullMQ passes it.
vi.mock("@/lib/queue/processor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue/processor")>()),
  calculateBackoffDelay: vi.fn(() => 10),
}));

const PRODUCTION_LOCK_DURATION_MS = 5 * 60 * 1000;
const PRODUCTION_STALLED_INTERVAL_MS = 30_000;

const JOB_DATA: ReviewJobData = {
  type: "review-pr",
  payload: {
    installationId: 1001,
    githubRepoId: 2002,
    repositoryFullName: "octo-org/repo",
    pullRequestNumber: 7,
    commitSha: "abc123",
  },
};

interface Harness {
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;
  readonly workers: Worker<ReviewJobData>[];
  startWorker(timing?: {
    lockDurationMs: number;
    stalledIntervalMs: number;
  }): Worker<ReviewJobData>;
}

let harness: Harness;

beforeEach(() => {
  const connection = createValkeyConnectionOptions();
  const queueName = `test-review-jobs-${randomUUID()}`;
  const queue = new Queue(queueName, {
    connection,
    defaultJobOptions: REVIEW_JOB_OPTIONS,
  });
  const deadLetterQueue = new Queue(`${queueName}-dead-letter`, {
    connection,
  });
  const workers: Worker<ReviewJobData>[] = [];
  harness = {
    queue,
    deadLetterQueue,
    workers,
    startWorker: (
      timing = {
        lockDurationMs: PRODUCTION_LOCK_DURATION_MS,
        stalledIntervalMs: PRODUCTION_STALLED_INTERVAL_MS,
      },
    ) => {
      const worker = createReviewWorker({
        connection,
        queueName,
        deadLetterQueue,
        ...timing,
      });
      workers.push(worker);
      return worker;
    },
  };

  vi.mocked(executeReview).mockReset();
  vi.mocked(calculateBackoffDelay).mockClear();
  vi.mocked(createGitHubServiceFromEnv).mockReturnValue(
    createMockGitHubService(),
  );
  vi.mocked(createLlmClient).mockReturnValue(createMockLlmService());
});

afterEach(async () => {
  await Promise.all(harness.workers.map((worker) => worker.close(true)));
  for (const queue of [harness.queue, harness.deadLetterQueue]) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

async function waitUntil<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (isDone(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function jobRecords() {
  return testPrisma.job.findMany();
}

async function deadLetters() {
  return waitUntil(
    () => harness.deadLetterQueue.getJobs(["waiting"]),
    (jobs) => jobs.length > 0,
  );
}

function reviewFailsWith(error: ReviewEngineError): void {
  vi.mocked(executeReview).mockResolvedValue(err(error));
}

function reviewCalls(): ReviewRequest[] {
  return vi.mocked(executeReview).mock.calls.map(([request]) => request);
}

describe("review job lifecycle on real BullMQ and Valkey", () => {
  it("marks the job record COMPLETED after a successful review", async () => {
    vi.mocked(executeReview).mockResolvedValue(ok(createReviewEngineResult()));
    harness.startWorker();

    const job = await harness.queue.add("review-pr", JOB_DATA);

    const [record] = await waitUntil(jobRecords, (records) =>
      records.some((r) => r.status === "COMPLETED"),
    );
    expect(record).toMatchObject({ type: "review-pr", status: "COMPLETED" });
    expect(record?.processedAt).not.toBeNull();
    expect(await job.getState()).toBe("completed");
    expect(reviewCalls()).toHaveLength(1);
  });

  it("fails an unrecoverable error after one attempt and dead-letters it", async () => {
    reviewFailsWith("REVIEW_DIFF_UNAVAILABLE");
    harness.startWorker();

    const job = await harness.queue.add("review-pr", JOB_DATA);

    const [deadLetter] = await deadLetters();
    expect(deadLetter?.data).toMatchObject({
      originalJobId: job.id,
      error: "Review failed: REVIEW_DIFF_UNAVAILABLE",
    });
    expect(await jobRecords()).toMatchObject([
      { status: "FAILED", lastError: "REVIEW_DIFF_UNAVAILABLE", attempts: 1 },
    ]);
    const failedJob = await harness.queue.getJob(job.id ?? "");
    expect(failedJob?.attemptsMade).toBe(1);
    expect(await failedJob?.getState()).toBe("failed");
    expect(reviewCalls()).toHaveLength(1);
    expect(calculateBackoffDelay).not.toHaveBeenCalled();
  });

  it("retries a retryable error, then fails the record and dead-letters it", async () => {
    reviewFailsWith("REVIEW_LLM_FAILED");
    harness.startWorker();

    const job = await harness.queue.add("review-pr", JOB_DATA);

    await deadLetters();
    expect(reviewCalls().map((request) => request.isFinalAttempt)).toEqual([
      false,
      false,
      true,
    ]);
    expect(vi.mocked(calculateBackoffDelay).mock.calls).toEqual([
      [
        1,
        expect.objectContaining({
          message: "Review failed: REVIEW_LLM_FAILED",
        }),
      ],
      [
        2,
        expect.objectContaining({
          message: "Review failed: REVIEW_LLM_FAILED",
        }),
      ],
    ]);
    // Every attempt reuses the one record (#53).
    expect(await jobRecords()).toMatchObject([
      { status: "FAILED", lastError: "REVIEW_LLM_FAILED", attempts: 3 },
    ]);
    const failedJob = await harness.queue.getJob(job.id ?? "");
    expect(failedJob?.attemptsMade).toBe(3);
    expect(await harness.deadLetterQueue.getJobCountByTypes("waiting")).toBe(1);
  });

  it("fails the job record when the job stalls more than BullMQ allows (#66)", async () => {
    // Each worker that takes the job hangs in the review and then dies
    // without releasing the lock, as a crashed process would.
    vi.mocked(executeReview).mockReturnValue(new Promise(() => {}));
    const fastStallChecks = { lockDurationMs: 1_000, stalledIntervalMs: 250 };

    const job = await harness.queue.add("review-pr", JOB_DATA);
    for (const attempt of [1, 2]) {
      const worker = harness.startWorker(fastStallChecks);
      await waitUntil(
        async () => reviewCalls().length,
        (calls) => calls === attempt,
      );
      await worker.close(true);
    }
    harness.startWorker(fastStallChecks);

    const [deadLetter] = await deadLetters();
    expect(deadLetter?.data).toMatchObject({
      originalJobId: job.id,
      error: expect.stringContaining("stalled more than allowable limit"),
    });
    const [record] = await jobRecords();
    expect(record?.status).toBe("FAILED");
    expect(record?.lastError).toContain("stalled more than allowable limit");
    expect(record?.processedAt).not.toBeNull();
    expect(reviewCalls()).toHaveLength(2);
  });

  it("keeps the final status when a run that lost its lock finishes later (#115)", async () => {
    // Run A hangs in the review; run B is the stall re-run that replaces it.
    let finishRunA: (value: Awaited<ReturnType<typeof executeReview>>) => void =
      () => {};
    vi.mocked(executeReview)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishRunA = resolve;
        }),
      )
      .mockResolvedValue(ok(createReviewEngineResult()));
    harness.startWorker({ lockDurationMs: 1_000, stalledIntervalMs: 250 });

    const job = await harness.queue.add("review-pr", JOB_DATA);
    await waitUntil(
      async () => reviewCalls().length,
      (calls) => calls === 1,
    );
    // BullMQ does not stop a run whose lock is gone; it only reports the
    // failed renewal. The stall checker then hands the job to run B.
    const client = await harness.queue.client;
    await client.del(`${harness.queue.toKey(job.id ?? "")}:lock`);
    await waitUntil(
      () => job.getState(),
      (state) => state === "completed",
    );
    expect(await jobRecords()).toMatchObject([{ status: "COMPLETED" }]);

    finishRunA(err("REVIEW_LLM_FAILED"));
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await jobRecords()).toMatchObject([{ status: "COMPLETED" }]);
    expect(reviewCalls()).toHaveLength(2);
  });
});
