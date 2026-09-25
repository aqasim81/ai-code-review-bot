/**
 * What a signed-in user may see and change in the dashboard, as reported by
 * GitHub at sign-in. Repository IDs are GitHub's IDs, not database IDs.
 */
export interface AccessScope {
  readonly githubInstallationIds: readonly number[];
  readonly accessibleGithubRepoIds: readonly number[];
  /** Repositories where the user has admin or maintain permission. */
  readonly manageableGithubRepoIds: readonly number[];
}

export interface UserAccess extends AccessScope {
  /** True when the user can access more repositories than the session holds. */
  readonly truncated: boolean;
}
