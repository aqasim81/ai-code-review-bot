import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries");

import {
  failAbandonedJobRecord,
  findAbandonedJobRecordIds,
} from "@/lib/db/queries";
import {
  ABANDONED_JOB_RECORD_MS,
  expireAbandonedJobRecords,
} from "@/lib/queue/stale-job-records";
import { err, ok } from "@/types/results";

const NOW = new Date("2026-09-26T12:00:00Z").getTime();
const CUTOFF = new Date(NOW - ABANDONED_JOB_RECORD_MS);

describe("expireAbandonedJobRecords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(failAbandonedJobRecord).mockResolvedValue(ok(true));
  });

  it("fails every abandoned record using the 30-minute cutoff", async () => {
    vi.mocked(findAbandonedJobRecordIds).mockResolvedValue(ok(["a", "b"]));

    const result = await expireAbandonedJobRecords(NOW);

    expect(result).toEqual({ success: true, data: { expiredCount: 2 } });
    expect(findAbandonedJobRecordIds).toHaveBeenCalledWith(CUTOFF);
    expect(failAbandonedJobRecord).toHaveBeenCalledWith("a", CUTOFF);
    expect(failAbandonedJobRecord).toHaveBeenCalledWith("b", CUTOFF);
  });

  it("does not count a record that was renewed before it could be failed", async () => {
    vi.mocked(findAbandonedJobRecordIds).mockResolvedValue(ok(["a", "b"]));
    vi.mocked(failAbandonedJobRecord)
      .mockResolvedValueOnce(ok(false))
      .mockResolvedValueOnce(ok(true));

    const result = await expireAbandonedJobRecords(NOW);

    expect(result).toEqual({ success: true, data: { expiredCount: 1 } });
  });

  it("keeps going when failing one record fails", async () => {
    vi.mocked(findAbandonedJobRecordIds).mockResolvedValue(ok(["a", "b"]));
    vi.mocked(failAbandonedJobRecord)
      .mockResolvedValueOnce(err("DB down"))
      .mockResolvedValueOnce(ok(true));

    const result = await expireAbandonedJobRecords(NOW);

    expect(result).toEqual({ success: true, data: { expiredCount: 1 } });
    expect(failAbandonedJobRecord).toHaveBeenCalledTimes(2);
  });

  it("returns an error when abandoned records cannot be listed", async () => {
    vi.mocked(findAbandonedJobRecordIds).mockResolvedValue(err("DB down"));

    const result = await expireAbandonedJobRecords(NOW);

    expect(result).toEqual({
      success: false,
      error: "JOB_RECORD_SWEEP_FAILED",
    });
    expect(failAbandonedJobRecord).not.toHaveBeenCalled();
  });
});
