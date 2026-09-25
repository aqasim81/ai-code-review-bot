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

/**
 * Why the user's access could not be read from GitHub, by what a retry can do:
 * a server error, timeout or race may pass within seconds; a rate limit lasts
 * until it resets; a refused token never changes on a retry.
 */
export interface UserAccessFetchError {
  readonly kind: "retryable" | "rate-limited" | "permanent";
  readonly message: string;
}
