import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "@/lib/heartbeat";
import { logger } from "@/lib/logger";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startHeartbeat", () => {
  it("beats every interval until stopped", async () => {
    const beat = vi.fn(async () => {});
    const stop = startHeartbeat("test", beat, 1_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(beat).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it("does not start a beat while the previous one is still running", async () => {
    let finishBeat: () => void = () => {};
    const beat = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishBeat = resolve;
        }),
    );
    const stop = startHeartbeat("test", beat, 1_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(beat).toHaveBeenCalledTimes(1);

    finishBeat();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(beat).toHaveBeenCalledTimes(2);
    stop();
  });

  it("logs a beat that throws and keeps beating", async () => {
    const beat = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(undefined);
    const stop = startHeartbeat("test", beat, 1_000);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(logger.error).toHaveBeenCalledWith(
      "Heartbeat failed",
      expect.objectContaining({ heartbeat: "test" }),
    );
    expect(beat).toHaveBeenCalledTimes(2);
    stop();
  });
});
