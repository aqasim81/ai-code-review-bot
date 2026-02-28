import { createSign } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { logger } from "@/lib/logger";
import type { GitHubError } from "@/types/errors";
import type {
  GitHubService,
  PostedReviewResult,
  PullRequestReviewPayload,
} from "@/types/github";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

interface GitHubAppCredentials {
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

async function createInstallationAccessToken(
  credentials: GitHubAppCredentials,
  installationId: number,
): Promise<Result<string, GitHubError>> {
  try {
    const jwt = createGitHubAppJwt(credentials);
    const appOctokit = new Octokit({ auth: jwt });

    const response = await appOctokit.apps.createInstallationAccessToken({
      installation_id: installationId,
    });

    return ok(response.data.token);
  } catch (error) {
    logger.error("Failed to create installation access token", {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err("GITHUB_AUTH_FAILED");
  }
}

function classifyGitHubError(error: unknown): GitHubError {
  if (error instanceof Error && "status" in error) {
    const statusValue = (error as Record<string, unknown>).status;
    if (typeof statusValue === "number") {
      if (statusValue === 401 || statusValue === 400)
        return "GITHUB_AUTH_FAILED";
      if (statusValue === 403) return "GITHUB_FORBIDDEN";
      if (statusValue === 404) return "GITHUB_NOT_FOUND";
      if (statusValue === 429) return "GITHUB_RATE_LIMITED";
    }
  }
  return "GITHUB_UNKNOWN_ERROR";
}

function isAuthError(error: unknown): boolean {
  if (error instanceof Error && "status" in error) {
    const statusValue = (error as Record<string, unknown>).status;
    return statusValue === 401;
  }
  return false;
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
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  } catch {
    // Non-critical — continue even if rate limit check fails
  }
}

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry
const GITHUB_TOKEN_LIFETIME_MS = 60 * 60 * 1000; // Tokens last 1 hour

export function createGitHubService(
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
    if (isTokenExpired()) {
      clearToken();
      const tokenResult = await createInstallationAccessToken(
        credentials,
        installationId,
      );
      if (!tokenResult.success) return tokenResult;
      cachedToken = tokenResult.data;
      tokenCreatedAt = Date.now();
    }
    return ok(new Octokit({ auth: cachedToken }));
  }

  return {
    async fetchPullRequestDiff(
      owner: string,
      repo: string,
      pullNumber: number,
    ): Promise<Result<string, GitHubError>> {
      const octokitResult = await getOctokit();
      if (!octokitResult.success) return octokitResult;
      const octokit = octokitResult.data;

      try {
        await checkRateLimit(octokit);

        const response = await octokit.pulls.get({
          owner,
          repo,
          pull_number: pullNumber,
          mediaType: { format: "diff" },
        });

        // Octokit types don't account for diff mediaType returning a string
        const diff = response.data as unknown;
        if (typeof diff !== "string") {
          return err("GITHUB_UNKNOWN_ERROR");
        }
        return ok(diff);
      } catch (error) {
        if (isAuthError(error)) {
          clearToken();
        }
        logger.error("Failed to fetch PR diff", {
          owner,
          repo,
          pullNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        return err(classifyGitHubError(error));
      }
    },

    async fetchFileContent(
      owner: string,
      repo: string,
      filePath: string,
      ref: string,
    ): Promise<Result<string, GitHubError>> {
      const octokitResult = await getOctokit();
      if (!octokitResult.success) return octokitResult;
      const octokit = octokitResult.data;

      try {
        const response = await octokit.repos.getContent({
          owner,
          repo,
          path: filePath,
          ref,
        });

        const data = response.data;
        if (Array.isArray(data) || data.type !== "file") {
          return err("GITHUB_NOT_FOUND");
        }

        const content = Buffer.from(data.content, "base64").toString("utf-8");
        return ok(content);
      } catch (error) {
        if (isAuthError(error)) {
          clearToken();
        }
        logger.error("Failed to fetch file content", {
          owner,
          repo,
          filePath,
          ref,
          error: error instanceof Error ? error.message : String(error),
        });
        return err(classifyGitHubError(error));
      }
    },

    async postPullRequestReview(
      owner: string,
      repo: string,
      pullNumber: number,
      review: PullRequestReviewPayload,
    ): Promise<Result<PostedReviewResult, GitHubError>> {
      const octokitResult = await getOctokit();
      if (!octokitResult.success) return octokitResult;
      const octokit = octokitResult.data;

      try {
        await checkRateLimit(octokit);

        const comments = review.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: comment.body,
        }));

        const response = await octokit.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: review.commitSha,
          body: review.body,
          event: review.event,
          comments,
        });

        logger.info("Posted review to GitHub", {
          owner,
          repo,
          pullNumber,
          reviewId: response.data.id,
          commentCount: comments.length,
        });

        return ok({
          githubReviewId: response.data.id,
          postedCommentCount: comments.length,
        });
      } catch (error) {
        if (isAuthError(error)) {
          clearToken();
        }
        logger.error("Failed to post review", {
          owner,
          repo,
          pullNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        return err(classifyGitHubError(error));
      }
    },
  };
}
