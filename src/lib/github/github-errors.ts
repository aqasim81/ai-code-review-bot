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
