import type { Octokit } from "@octokit/rest";
import { describeError } from "@/lib/errors";
import {
  classifyGitHubError,
  readRateLimitRetryAt,
  readResponseStatus,
} from "@/lib/github/github-errors";
import { createOctokit } from "@/lib/github/octokit";
import type { UserAccess, UserAccessFetchError } from "@/types/access";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

const PAGE_SIZE = 100;
// Keeps the session cookie small; users with more repositories see the first
// ones and a notice, never more than GitHub reported.
export const MAX_SESSION_REPOSITORIES = 150;

interface RepositoryPermission {
  readonly id: number;
  readonly permissions?: {
    readonly admin: boolean;
    readonly maintain?: boolean;
  };
}

function isManageable(repository: RepositoryPermission): boolean {
  return (
    repository.permissions?.admin === true ||
    repository.permissions?.maintain === true
  );
}

async function listInstallationRepositories(
  octokit: Octokit,
  installationId: number,
  limit: number,
): Promise<readonly RepositoryPermission[]> {
  let collected = 0;
  return octokit.paginate(
    octokit.apps.listInstallationReposForAuthenticatedUser,
    { installation_id: installationId, per_page: PAGE_SIZE },
    (response, done) => {
      collected += response.data.length;
      if (collected > limit) done();
      return response.data;
    },
  );
}

/**
 * A 404 here means an installation was removed between listing the
 * installations and its repositories; the next lookup no longer lists it.
 * Anything without a known status (a server error, a network error or a
 * timeout, which Octokit reports as 500) may pass on a retry. A 401 means
 * the user's token expired or was revoked, so they have to sign in again.
 */
function classifyUserAccessError(
  error: unknown,
  now: number,
): UserAccessFetchError {
  const message = `Failed to fetch user repository access: ${describeError(error)}`;
  if (readResponseStatus(error) === 401) {
    return { kind: "token-rejected", message };
  }
  switch (classifyGitHubError(error)) {
    case "GITHUB_RATE_LIMITED":
      return {
        kind: "rate-limited",
        message,
        retryAt: readRateLimitRetryAt(error, now),
      };
    case "GITHUB_NOT_FOUND":
    case "GITHUB_UNKNOWN_ERROR":
      return { kind: "retryable", message };
    default:
      return { kind: "permanent", message };
  }
}

/**
 * Lists the installations the user can see and, within each, the
 * repositories they can access and whether they can manage them. Any failed
 * request fails the whole lookup so access is never partially granted.
 */
export async function fetchUserRepositoryAccess(
  accessToken: string,
): Promise<Result<UserAccess, UserAccessFetchError>> {
  try {
    const octokit = createOctokit(accessToken);
    const installations = await octokit.paginate(
      octokit.apps.listInstallationsForAuthenticatedUser,
      { per_page: PAGE_SIZE },
    );
    const installationIds = installations
      .map((installation) => installation.id)
      .sort((a, b) => a - b);

    const githubInstallationIds: number[] = [];
    const accessibleGithubRepoIds: number[] = [];
    const manageableGithubRepoIds: number[] = [];
    let truncated = false;

    for (const installationId of installationIds) {
      const remaining =
        MAX_SESSION_REPOSITORIES - accessibleGithubRepoIds.length;
      if (remaining === 0) {
        truncated = true;
        break;
      }
      const repositories = await listInstallationRepositories(
        octokit,
        installationId,
        remaining,
      );
      if (repositories.length > remaining) truncated = true;
      const kept = repositories.slice(0, remaining);
      if (kept.length === 0) continue;

      githubInstallationIds.push(installationId);
      for (const repository of kept) {
        accessibleGithubRepoIds.push(repository.id);
        if (isManageable(repository)) {
          manageableGithubRepoIds.push(repository.id);
        }
      }
    }

    return ok({
      githubInstallationIds,
      accessibleGithubRepoIds,
      manageableGithubRepoIds,
      truncated,
    });
  } catch (error) {
    return err(classifyUserAccessError(error, Date.now()));
  }
}
