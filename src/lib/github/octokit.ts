import { Octokit } from "@octokit/rest";

const GITHUB_REQUEST_TIMEOUT_MS = 60_000;
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * Fetches with a timeout that covers the body as well as the headers. The body
 * is read here because Octokit reads it after fetch returns and swallows read
 * errors (`@octokit/request` `getResponseData`: `text().catch(noop)`), so a
 * body cut off by the timeout there would come back as an empty success.
 * A timeout rejects fetch, which Octokit reports as a status 500 error.
 */
async function fetchWithTimeout(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const signal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  const response = await fetch(url, { ...init, signal });
  const body = NULL_BODY_STATUSES.has(response.status)
    ? null
    : await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** An Octokit whose every request fails after a timeout instead of hanging. */
export function createOctokit(auth: string): Octokit {
  return new Octokit({ auth, request: { fetch: fetchWithTimeout } });
}
