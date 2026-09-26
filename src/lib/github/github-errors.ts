import type { GitHubError } from "@/types/errors";

function readResponseHeaders(error: Error): Record<string, unknown> {
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return {};
  const headers = (response as { headers?: unknown }).headers;
  return typeof headers === "object" && headers !== null
    ? (headers as Record<string, unknown>)
    : {};
}

/**
 * GitHub reports primary and secondary rate limits as 403 as well as 429; they
 * carry no remaining requests, a retry-after header or a "rate limit" message.
 */
function isRateLimitResponse(error: Error): boolean {
  const headers = readResponseHeaders(error);
  return (
    headers["x-ratelimit-remaining"] === "0" ||
    headers["retry-after"] !== undefined ||
    /rate limit/i.test(error.message)
  );
}

// GitHub asks for at least a minute's wait after a secondary rate limit that
// names no time.
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

function readNumberHeader(
  headers: Record<string, unknown>,
  name: string,
): number | null {
  const value = Number(headers[name]);
  return typeof headers[name] === "string" && Number.isFinite(value)
    ? value
    : null;
}

/**
 * When GitHub allows the next request after a rate limit (ms epoch), per its
 * rate-limit docs: `retry-after` seconds, else `x-ratelimit-reset` (UTC epoch
 * seconds) when no requests remain, else at least a minute.
 */
export function readRateLimitRetryAt(error: unknown, now: number): number {
  const headers = error instanceof Error ? readResponseHeaders(error) : {};
  const retryAfterSeconds = readNumberHeader(headers, "retry-after");
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
    return now + retryAfterSeconds * 1000;
  }
  const resetSeconds = readNumberHeader(headers, "x-ratelimit-reset");
  if (headers["x-ratelimit-remaining"] === "0" && resetSeconds !== null) {
    return Math.max(resetSeconds * 1000, now + 1000);
  }
  return now + DEFAULT_RATE_LIMIT_WAIT_MS;
}

export function readResponseStatus(error: unknown): number | null {
  if (!(error instanceof Error) || !("status" in error)) return null;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}

export function classifyGitHubError(error: unknown): GitHubError {
  const status = readResponseStatus(error);
  if (status === 401 || status === 400) return "GITHUB_AUTH_FAILED";
  if (status === 429) return "GITHUB_RATE_LIMITED";
  if (status === 403) {
    return isRateLimitResponse(error as Error)
      ? "GITHUB_RATE_LIMITED"
      : "GITHUB_FORBIDDEN";
  }
  if (status === 404) return "GITHUB_NOT_FOUND";
  // 406: the diff is too large for GitHub to produce; 422: GitHub refused the
  // request as invalid. Neither changes on a retry.
  if (status === 406 || status === 422) return "GITHUB_REQUEST_REJECTED";
  return "GITHUB_UNKNOWN_ERROR";
}
