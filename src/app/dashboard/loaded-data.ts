import { logger } from "@/lib/logger";
import type { Result } from "@/types/results";

// Distributes over the Result union, so the failure branch drops out.
type DataOf<R> = R extends { success: true; data: infer D } ? D : never;

type LoadedData<T extends Record<string, Result<unknown, string>>> = {
  readonly [K in keyof T]: DataOf<T[K]>;
};

/**
 * The data of a dashboard page's queries, or null when any of them failed.
 * Each failure is logged. A page shows a load error for null rather than
 * treating the failure as "no rows".
 */
export function loadedDataOrLogFailures<
  T extends Record<string, Result<unknown, string>>,
>(page: string, results: T): LoadedData<T> | null {
  const data: Record<string, unknown> = {};
  let failed = false;
  for (const [query, result] of Object.entries(results)) {
    if (result.success) {
      data[query] = result.data;
      continue;
    }
    failed = true;
    logger.error("Dashboard query failed", {
      page,
      query,
      error: result.error,
    });
  }
  return failed ? null : (data as LoadedData<T>);
}
