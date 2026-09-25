import { createSign } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { createOctokit } from "@/lib/github/octokit";
import { selectReviewWithMarker } from "@/lib/github/review-marker";
import { logger } from "@/lib/logger";
import { sleep } from "@/lib/retry";
import type { GitHubError } from "@/types/errors";
import type { CommitComparisonFileStatus, GitHubService } from "@/types/github";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

export interface GitHubAppCredentials {
  readonly appId: string;
  readonly privateKey: string;
}

function createGitHubAppJwt(credentials: GitHubAppCredentials): string {
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");

  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: credentials.appId,
    }),
  ).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(credentials.privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

let cachedAppBotLogin: string | null = null;

/**
 * The login GitHub uses for reviews this app posts (`<slug>[bot]`), read from
 * `GET /app` rather than configuration so it cannot drift from the real app.
 */
async function getAppBotLogin(
  credentials: GitHubAppCredentials,
): Promise<Result<string, GitHubError>> {
  if (cachedAppBotLogin !== null) return ok(cachedAppBotLogin);
  try {
    const appOctokit = createOctokit(createGitHubAppJwt(credentials));
    const { data } = await appOctokit.apps.getAuthenticated();
    if (!data?.slug) return err("GITHUB_UNKNOWN_ERROR");
    cachedAppBotLogin = `${data.slug}[bot]`;
    return ok(cachedAppBotLogin);
  } catch (error) {
    logger.error("Failed to look up the GitHub App", {
      error: describeError(error),
    });
    return err(classifyGitHubError(error));
  }
}

async function createInstallationAccessToken(
  credentials: GitHubAppCredentials,
  installationId: number,
): Promise<Result<string, GitHubError>> {
  try {
    const jwt = createGitHubAppJwt(credentials);
    const appOctokit = createOctokit(jwt);

    const response = await appOctokit.apps.createInstallationAccessToken({
      installation_id: installationId,
    });

    return ok(response.data.token);
  } catch (error) {
    logger.error("Failed to create installation access token", {
      installationId,
      error: describeError(error),
    });
    return err(classifyInstallationTokenError(error));
  }
}

/**
 * GitHub answers a token request for a deleted installation with 404 and for
 * a suspended one with 403. Neither changes on a retry.
 */
function classifyInstallationTokenError(error: unknown): GitHubError {
  const classified = classifyGitHubError(error);
  return classified === "GITHUB_NOT_FOUND" || classified === "GITHUB_FORBIDDEN"
    ? "GITHUB_INSTALLATION_UNAVAILABLE"
    : classified;
}

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

function readResponseStatus(error: unknown): number | null {
  if (!(error instanceof Error) || !("status" in error)) return null;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}

function classifyGitHubError(error: unknown): GitHubError {
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

function isAuthError(error: unknown): boolean {
  return readResponseStatus(error) === 401;
}

const RATE_LIMIT_THRESHOLD = 10;
const RATE_LIMIT_PAUSE_MS = 60_000;

async function checkRateLimit(octokit: Octokit): Promise<void> {
  try {
    const { data } = await octokit.rateLimit.get();
    const remaining = data.resources.core.remaining;
    if (remaining < RATE_LIMIT_THRESHOLD) {
      const resetAt = data.resources.core.reset * 1000;
      const waitMs = Math.min(resetAt - Date.now(), RATE_LIMIT_PAUSE_MS);
      if (waitMs > 0) {
        logger.warn("Rate limit low, pausing", { remaining, waitMs });
        await sleep(waitMs);
      }
    }
  } catch {
    // Non-critical — continue even if rate limit check fails
  }
}

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry
const GITHUB_TOKEN_LIFETIME_MS = 60 * 60 * 1000; // Tokens last 1 hour

export function createGitHubServiceFromEnv(
  installationId: number,
): GitHubService {
  return createGitHubService(
    { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY },
    installationId,
  );
}

function createGitHubService(
  credentials: GitHubAppCredentials,
  installationId: number,
): GitHubService {
  let cachedToken: string | null = null;
  let tokenCreatedAt = 0;

  function isTokenExpired(): boolean {
    if (!cachedToken) return true;
    return (
      Date.now() - tokenCreatedAt >
      GITHUB_TOKEN_LIFETIME_MS - TOKEN_EXPIRY_BUFFER_MS
    );
  }

  function clearToken(): void {
    cachedToken = null;
    tokenCreatedAt = 0;
  }

  async function getOctokit(): Promise<Result<Octokit, GitHubError>> {
    if (cachedToken !== null && !isTokenExpired()) {
      return ok(createOctokit(cachedToken));
    }
    clearToken();
    const tokenResult = await createInstallationAccessToken(
      credentials,
      installationId,
    );
    if (!tokenResult.success) return tokenResult;
    cachedToken = tokenResult.data;
    tokenCreatedAt = Date.now();
    return ok(createOctokit(tokenResult.data));
  }

  /**
   * Runs one request with a fresh token. A 401 drops the cached token; every
   * failure is logged and classified.
   */
  async function callGitHub<T>(
    failureMessage: string,
    logContext: Record<string, unknown>,
    request: (octokit: Octokit) => Promise<Result<T, GitHubError>>,
    options: { readonly rateLimitCheck: boolean } = { rateLimitCheck: true },
  ): Promise<Result<T, GitHubError>> {
    const octokitResult = await getOctokit();
    if (!octokitResult.success) return octokitResult;
    const octokit = octokitResult.data;

    try {
      if (options.rateLimitCheck) await checkRateLimit(octokit);
      return await request(octokit);
    } catch (error) {
      if (isAuthError(error)) clearToken();
      logger.error(failureMessage, {
        ...logContext,
        error: describeError(error),
      });
      return err(classifyGitHubError(error));
    }
  }

  return {
    fetchPullRequestDiff(owner, repo, pullNumber) {
      return callGitHub(
        "Failed to fetch PR diff",
        { owner, repo, pullNumber },
        async (octokit) => {
          const response = await octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
            mediaType: { format: "diff" },
          });
          // Octokit types don't account for diff mediaType returning a string
          const diff = response.data as unknown;
          return typeof diff === "string"
            ? ok(diff)
            : err("GITHUB_UNKNOWN_ERROR");
        },
      );
    },

    fetchPullRequestHeadSha(owner, repo, pullNumber) {
      return callGitHub(
        "Failed to fetch pull request head",
        { owner, repo, pullNumber },
        async (octokit) => {
          const { data } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
          });
          return ok(data.head.sha);
        },
      );
    },

    fetchFileContent(owner, repo, filePath, ref) {
      return callGitHub(
        "Failed to fetch file content",
        { owner, repo, filePath, ref },
        async (octokit) => {
          const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: filePath,
            ref,
          });
          if (Array.isArray(data) || data.type !== "file") {
            return err("GITHUB_NOT_FOUND");
          }
          // For files over 1 MB GitHub returns encoding "none" and no content.
          if (data.encoding !== "base64") {
            return err("GITHUB_CONTENT_TOO_LARGE");
          }
          return ok(Buffer.from(data.content, "base64").toString("utf-8"));
        },
        { rateLimitCheck: false },
      );
    },

    postPullRequestReview(owner, repo, pullNumber, review) {
      return callGitHub(
        "Failed to post review",
        { owner, repo, pullNumber },
        async (octokit) => {
          const response = await octokit.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            commit_id: review.commitSha,
            body: review.body,
            event: review.event,
            comments: [...review.comments],
          });
          const postedCommentCount = review.comments.length;
          logger.info("Posted review to GitHub", {
            owner,
            repo,
            pullNumber,
            reviewId: response.data.id,
            commentCount: postedCommentCount,
          });
          return ok({ githubReviewId: response.data.id, postedCommentCount });
        },
      );
    },

    async findPostedReview(owner, repo, pullNumber, marker) {
      const botLoginResult = await getAppBotLogin(credentials);
      if (!botLoginResult.success) return botLoginResult;

      return callGitHub(
        "Failed to list pull request reviews",
        { owner, repo, pullNumber },
        async (octokit) => {
          const reviews = await octokit.paginate(octokit.pulls.listReviews, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
          });
          return ok(
            selectReviewWithMarker(
              reviews.map((review) => ({
                id: review.id,
                body: review.body,
                user: review.user
                  ? { login: review.user.login, type: review.user.type }
                  : null,
              })),
              marker,
              botLoginResult.data,
            ),
          );
        },
      );
    },

    compareCommits(owner, repo, baseSha, headSha) {
      return callGitHub(
        "Failed to compare commits",
        { owner, repo, baseSha, headSha },
        async (octokit) => {
          const response = await octokit.repos.compareCommits({
            owner,
            repo,
            base: baseSha,
            head: headSha,
          });
          const files = (response.data.files ?? []).map((file) => ({
            filename: file.filename,
            status: (file.status ?? "modified") as CommitComparisonFileStatus,
          }));
          return ok({ status: response.data.status, files });
        },
      );
    },
  };
}
