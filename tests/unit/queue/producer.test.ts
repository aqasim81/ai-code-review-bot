import { beforeEach, describe, expect, it, vi } from "vitest";

const queueAdd = vi.hoisted(() => vi.fn());
const queueGetJob = vi.hoisted(() => vi.fn());

vi.mock("bullmq", () => ({
  Queue: vi.fn(function MockQueue() {
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
  repositoryFullName: "octo/repo",
  pullRequestNumber: 42,
  commitSha: COMMIT_SHA,
};
const DELTA_PAYLOAD = { ...PAYLOAD, previousCommitSha: "b".repeat(40) };
const FULL_JOB_ID = `review-octo/repo-42-${COMMIT_SHA}-full`;

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
    const delta = await enqueueDeltaReviewJob(DELTA_PAYLOAD);

    expect(full).toEqual({ success: true, data: { jobId: FULL_JOB_ID } });
    expect(delta).toEqual({
      success: true,
      data: { jobId: `review-octo/repo-42-${COMMIT_SHA}-delta` },
    });
  });

  it("uses the same job ID for a redelivery of the same event", async () => {
    await enqueueReviewJob(PAYLOAD);
    await enqueueReviewJob(PAYLOAD);

    expect(addedJobId(0)).toBe(FULL_JOB_ID);
    expect(addedJobId(1)).toBe(FULL_JOB_ID);
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

  it("keeps a job with the same ID that has not failed, so the redelivery is deduped", async () => {
    const liveJob = existingJob(false);
    queueGetJob.mockResolvedValueOnce(liveJob);

    const result = await enqueueReviewJob(PAYLOAD);

    expect(result.success).toBe(true);
    expect(liveJob.remove).not.toHaveBeenCalled();
    expect(addedJobId(0)).toBe(FULL_JOB_ID);
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

    const result = await enqueueDeltaReviewJob(DELTA_PAYLOAD);

    expect(result).toEqual({ success: false, error: "QUEUE_ENQUEUE_FAILED" });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("returns QUEUE_ENQUEUE_FAILED when adding the job fails", async () => {
    queueAdd.mockRejectedValueOnce(new Error("connection lost"));

    const result = await enqueueReviewJob(PAYLOAD);

    expect(result).toEqual({ success: false, error: "QUEUE_ENQUEUE_FAILED" });
  });
});
