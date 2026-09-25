import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queueAdd = vi.hoisted(() => vi.fn());
const queueGetJob = vi.hoisted(() => vi.fn());
// Kept across vi.clearAllMocks: the producer builds its Queue once.
const createdQueueOptions = vi.hoisted((): unknown[] => []);

vi.mock("bullmq", () => ({
  Queue: vi.fn(function MockQueue(_name: string, options: unknown) {
    createdQueueOptions.push(options);
    return { add: queueAdd, getJob: queueGetJob };
  }),
}));
vi.mock("@/lib/queue/connection", () => ({
  createValkeyConnectionOptions: () => ({}),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { enqueueDeltaReviewJob, enqueueReviewJob } from "@/lib/queue/producer";

const COMMIT_SHA = "a".repeat(40);
const PAYLOAD = {
  installationId: 1,
  githubRepoId: 555,
  repositoryFullName: "octo/repo",
  pullRequestNumber: 42,
  commitSha: COMMIT_SHA,
};
const FULL_JOB_ID = `review-octo/repo-42-${COMMIT_SHA}-full`;
// GitHub gives up on a webhook delivery that has not been answered in 10 s.
const GITHUB_DELIVERY_TIMEOUT_MS = 10_000;

function existingJob(failed: boolean) {
  return {
    isFailed: vi.fn().mockResolvedValue(failed),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function addedJobId(callIndex: number): unknown {
  return queueAdd.mock.calls[callIndex]?.[2]?.jobId;
}

describe("review job producer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueGetJob.mockResolvedValue(undefined);
    queueAdd.mockImplementation(
      (_name: string, _data: unknown, opts: { jobId: string }) =>
        Promise.resolve({ id: opts.jobId }),
    );
  });

  it("gives full and delta reviews of the same commit different job IDs", async () => {
    const full = await enqueueReviewJob(PAYLOAD);
    const delta = await enqueueDeltaReviewJob(PAYLOAD);

    expect(full).toEqual({ success: true, data: { jobId: FULL_JOB_ID } });
    expect(delta).toEqual({
      success: true,
      data: { jobId: `review-octo/repo-42-${COMMIT_SHA}-delta` },
    });
  });

  it("builds the same job ID for a redelivery of the same event", async () => {
    await enqueueReviewJob(PAYLOAD);
    await enqueueReviewJob(PAYLOAD);

    expect(queueGetJob).toHaveBeenNthCalledWith(1, FULL_JOB_ID);
    expect(queueGetJob).toHaveBeenNthCalledWith(2, FULL_JOB_ID);
  });

  it("removes a failed job with the same ID before enqueueing a re-trigger", async () => {
    const failedJob = existingJob(true);
    queueGetJob.mockResolvedValueOnce(failedJob);

    const result = await enqueueReviewJob(PAYLOAD);

    expect(result.success).toBe(true);
    expect(queueGetJob).toHaveBeenCalledWith(FULL_JOB_ID);
    expect(failedJob.remove).toHaveBeenCalledOnce();
    expect(failedJob.remove.mock.invocationCallOrder[0]).toBeLessThan(
      queueAdd.mock.invocationCallOrder[0] ?? 0,
    );
    expect(addedJobId(0)).toBe(FULL_JOB_ID);
  });

  it("skips a redelivery while a job with the same ID has not failed", async () => {
    const liveJob = existingJob(false);
    queueGetJob.mockResolvedValueOnce(liveJob);

    const result = await enqueueReviewJob(PAYLOAD);

    expect(result).toEqual({ success: true, data: { jobId: FULL_JOB_ID } });
    expect(liveJob.remove).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("returns QUEUE_ENQUEUE_FAILED when looking up the existing job fails", async () => {
    queueGetJob.mockRejectedValueOnce(new Error("connection lost"));

    const result = await enqueueReviewJob(PAYLOAD);

    expect(result).toEqual({ success: false, error: "QUEUE_ENQUEUE_FAILED" });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("returns QUEUE_ENQUEUE_FAILED when removing the failed job fails", async () => {
    const failedJob = existingJob(true);
    failedJob.remove.mockRejectedValueOnce(new Error("job is locked"));
    queueGetJob.mockResolvedValueOnce(failedJob);

    const result = await enqueueDeltaReviewJob(PAYLOAD);

    expect(result).toEqual({ success: false, error: "QUEUE_ENQUEUE_FAILED" });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("returns QUEUE_ENQUEUE_FAILED when adding the job fails", async () => {
    queueAdd.mockRejectedValueOnce(new Error("connection lost"));

    const result = await enqueueReviewJob(PAYLOAD);

    expect(result).toEqual({ success: false, error: "QUEUE_ENQUEUE_FAILED" });
  });

  describe("when Valkey does not answer", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails the enqueue before GitHub times out the delivery", async () => {
      vi.useFakeTimers();
      queueGetJob.mockReturnValueOnce(new Promise(() => {}));

      let settled: unknown;
      void enqueueReviewJob(PAYLOAD).then((result) => {
        settled = result;
      });
      await vi.advanceTimersByTimeAsync(GITHUB_DELIVERY_TIMEOUT_MS);

      expect(settled).toEqual({
        success: false,
        error: "QUEUE_ENQUEUE_FAILED",
      });
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it("fails the enqueue when adding the job never settles", async () => {
      vi.useFakeTimers();
      queueAdd.mockReturnValueOnce(new Promise(() => {}));

      let settled: unknown;
      void enqueueDeltaReviewJob(PAYLOAD).then((result) => {
        settled = result;
      });
      await vi.advanceTimersByTimeAsync(GITHUB_DELIVERY_TIMEOUT_MS);

      expect(settled).toEqual({
        success: false,
        error: "QUEUE_ENQUEUE_FAILED",
      });
    });

    it("rejects commands while disconnected instead of queueing them", async () => {
      await enqueueReviewJob(PAYLOAD);

      expect(createdQueueOptions).toHaveLength(1);
      expect(createdQueueOptions[0]).toMatchObject({
        connection: { enableOfflineQueue: false },
      });
    });
  });
});
