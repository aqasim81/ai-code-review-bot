import { describe, expect, it } from "vitest";
import {
  createJobRecord,
  type JobRecordRun,
  renewJobRecord,
  updateJobRecord,
} from "@/lib/db/queries";
import { expireAbandonedJobRecords } from "@/lib/queue/stale-job-records";
import { testPrisma } from "./database";

const MINUTE_MS = 60_000;

async function createRun(): Promise<JobRecordRun> {
  const created = await createJobRecord({
    type: "review-pr",
    payload: { pullRequestNumber: 7 },
    initialStatus: "PROCESSING",
  });
  if (!created.success) throw new Error(created.error);
  return created.data;
}

async function lastRenewedMinutesAgo(id: string, minutes: number) {
  await testPrisma.job.update({
    where: { id },
    data: { runRenewedAt: new Date(Date.now() - minutes * MINUTE_MS) },
  });
}

describe("job records whose run stopped reporting (#113)", () => {
  // A final status write that failed, or a worker killed between creating
  // the record and saving its ID on the queue job, leaves a PROCESSING
  // record that no run renews any more.
  it("fails a PROCESSING record nobody renewed for 30 minutes", async () => {
    const run = await createRun();
    await lastRenewedMinutesAgo(run.id, 31);

    const result = await expireAbandonedJobRecords(Date.now());

    expect(result).toEqual({ success: true, data: { expiredCount: 1 } });
    const row = await testPrisma.job.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(row).toMatchObject({
      status: "FAILED",
      lastError: "JOB_RECORD_ABANDONED",
      runToken: null,
    });
    expect(row.processedAt).not.toBeNull();
  });

  it("leaves a record whose run is still renewing it", async () => {
    const run = await createRun();
    await lastRenewedMinutesAgo(run.id, 45);
    expect(await renewJobRecord(run)).toEqual({ success: true, data: true });

    const result = await expireAbandonedJobRecords(Date.now());

    expect(result).toEqual({ success: true, data: { expiredCount: 0 } });
    expect(
      await testPrisma.job.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "PROCESSING" });
  });

  it("leaves a record that already has a final status", async () => {
    const run = await createRun();
    await updateJobRecord(run, "COMPLETED");
    await lastRenewedMinutesAgo(run.id, 60);

    const result = await expireAbandonedJobRecords(Date.now());

    expect(result).toEqual({ success: true, data: { expiredCount: 0 } });
    expect(
      await testPrisma.job.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "COMPLETED" });
  });

  it("does not renew a record the sweep already failed", async () => {
    const run = await createRun();
    await lastRenewedMinutesAgo(run.id, 31);
    await expireAbandonedJobRecords(Date.now());

    expect(await renewJobRecord(run)).toEqual({ success: true, data: false });
    expect(
      await testPrisma.job.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "FAILED" });
  });
});
