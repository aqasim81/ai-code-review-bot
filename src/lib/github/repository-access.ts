import type { AccessScope, UserAccess } from "@/types/access";

export const EMPTY_USER_ACCESS: UserAccess = {
  githubInstallationIds: [],
  accessibleGithubRepoIds: [],
  manageableGithubRepoIds: [],
  truncated: false,
};

function isIdList(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isInteger(item))
  );
}

/**
 * Reads access data from a session token. Anything malformed, including
 * tokens issued before repository-level access existed, grants nothing.
 */
export function parseUserAccess(value: unknown): UserAccess {
  if (typeof value !== "object" || value === null) return EMPTY_USER_ACCESS;
  const record = value as Record<string, unknown>;
  const {
    githubInstallationIds,
    accessibleGithubRepoIds,
    manageableGithubRepoIds,
    truncated,
  } = record;
  if (
    !isIdList(githubInstallationIds) ||
    !isIdList(accessibleGithubRepoIds) ||
    !isIdList(manageableGithubRepoIds) ||
    typeof truncated !== "boolean"
  ) {
    return EMPTY_USER_ACCESS;
  }
  const accessible = new Set(accessibleGithubRepoIds);
  return {
    githubInstallationIds,
    accessibleGithubRepoIds,
    manageableGithubRepoIds: manageableGithubRepoIds.filter((id) =>
      accessible.has(id),
    ),
    truncated,
  };
}

export function canManageRepository(
  scope: AccessScope,
  githubRepoId: number,
): boolean {
  return scope.manageableGithubRepoIds.includes(githubRepoId);
}
