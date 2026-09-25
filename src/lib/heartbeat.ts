import { describeError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Calls `beat` every `intervalMs` until the returned stop function is called.
 * A beat still in flight when the next one is due is not overlapped, and a
 * beat that throws is logged, never propagated.
 */
export function startHeartbeat(
  name: string,
  beat: () => Promise<unknown>,
  intervalMs: number,
): () => void {
  let beatInFlight = false;
  const timer = setInterval(() => {
    if (beatInFlight) return;
    beatInFlight = true;
    beat()
      .catch((error: unknown) => {
        logger.error("Heartbeat failed", {
          heartbeat: name,
          error: describeError(error),
        });
      })
      .finally(() => {
        beatInFlight = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
