import { createHash } from "node:crypto";
import type { FetchedAccess } from "@/lib/github/access-refresh";
import { fetchUserRepositoryAccess } from "@/lib/github/user-installations";
import type { UserAccessFetchError } from "@/types/access";
import type { Result } from "@/types/results";
import { ok } from "@/types/results";

// A regular refresh reuses a result for 30 s: one dashboard request runs the
// session callback in middleware, the layout and the page. A forced refresh
// can be requested by the client at will, so it reuses a result for 10 s;
// this server-side limit holds even if the client replays an old cookie.
// A failure a retry can fix is shared only while in flight, so a refresh the
// user is waiting for is not answered with an error that has since passed.
const REGULAR_MAX_AGE_MS = 30_000;
const FORCED_MAX_AGE_MS = 10_000;

interface CacheEntry {
  readonly fetchedAt: number;
  readonly forced: boolean;
  readonly result: Promise<Result<FetchedAccess, UserAccessFetchError>>;
}

const cache = new Map<string, CacheEntry>();

// Keys are hashes so live tokens are not kept in memory as map keys. Hashing
// synchronously keeps the lookup and the insert in one step, so callers that
// arrive together always share one fetch.
function hashToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

async function fetchAndStamp(
  accessToken: string,
  fetchedAt: number,
): Promise<Result<FetchedAccess, UserAccessFetchError>> {
  const result = await fetchUserRepositoryAccess(accessToken);
  if (!result.success) return result;
  return ok({ access: result.data, fetchedAt });
}

export async function fetchUserRepositoryAccessShared(
  accessToken: string,
  options: { readonly now: number; readonly forced: boolean },
): Promise<Result<FetchedAccess, UserAccessFetchError>> {
  const { now, forced } = options;
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt >= REGULAR_MAX_AGE_MS) cache.delete(key);
  }

  const key = hashToken(accessToken);
  const hit = cache.get(key);
  // A forced refresh only reuses another forced one: a regular result from
  // just before the user installed the app would miss the new installation.
  const reusable = forced
    ? hit?.forced === true && now - hit.fetchedAt < FORCED_MAX_AGE_MS
    : hit !== undefined && now - hit.fetchedAt < REGULAR_MAX_AGE_MS;
  if (hit && reusable) return hit.result;

  const result = fetchAndStamp(accessToken, now);
  const entry: CacheEntry = { fetchedAt: now, forced, result };
  cache.set(key, entry);
  const settled = await result;
  if (!settled.success && settled.error.kind === "retryable") {
    if (cache.get(key) === entry) cache.delete(key);
  }
  return settled;
}
