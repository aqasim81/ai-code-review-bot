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
 * until it resets; a token GitHub rejects means the user has to sign in
 * again; any other refusal never changes on a retry.
 */
export type UserAccessFetchError =
  | {
      readonly kind: "retryable" | "permanent" | "token-rejected";
      readonly message: string;
    }
  | {
      readonly kind: "rate-limited";
      readonly message: string;
      /** When GitHub allows the next request (ms epoch). */
      readonly retryAt: number;
    };
