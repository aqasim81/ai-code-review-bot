import { fetchUserRepositoryAccess } from "@/lib/github/user-installations";
import type { UserAccess } from "@/types/access";
import type { Result } from "@/types/results";

// One dashboard request runs the session callback in middleware, the layout
// and the page; only middleware can store the refreshed cookie. Sharing the
// fetch for a short time keeps one refresh to one set of GitHub calls.
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly result: Promise<Result<UserAccess, string>>;
}

const cache = new Map<string, CacheEntry>();

export function fetchUserRepositoryAccessCached(
  accessToken: string,
  now: number,
): Promise<Result<UserAccess, string>> {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  const hit = cache.get(accessToken);
  if (hit) return hit.result;

  const result = fetchUserRepositoryAccess(accessToken);
  cache.set(accessToken, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}
