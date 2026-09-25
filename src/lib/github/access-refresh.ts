import { EMPTY_USER_ACCESS } from "@/lib/github/repository-access";
import type { UserAccess, UserAccessFetchError } from "@/types/access";
import type { Result } from "@/types/results";

export const ACCESS_REFRESH_INTERVAL_MS = 5 * 60_000;
const ACCESS_RETRY_INTERVAL_MS = 60_000;
// A refresh the user is waiting for is retried within seconds; the shared
// fetcher keeps GitHub from being asked more often than a retry can help.
const PENDING_RETRY_INTERVAL_MS = 5_000;

export interface AccessState {
  readonly access: UserAccess;
  /** When the access in use was fetched from GitHub (ms epoch, 0 = never). */
  readonly fetchedAt: number;
  /** When a refresh was last attempted (ms epoch, 0 = never). */
  readonly checkedAt: number;
  /**
   * A refresh the user asked for (sign-in, or after installing the app) has
   * not succeeded yet, so the access in use may be missing what they expect.
   */
  readonly pending: boolean;
}

export interface FetchedAccess {
  readonly access: UserAccess;
  /** When GitHub was asked; earlier than now when a shared result is reused. */
  readonly fetchedAt: number;
}

interface RefreshAccessInput {
  readonly state: AccessState;
  readonly accessToken: string | undefined;
  /** Refresh now, e.g. at sign-in or after installing the app. */
  readonly forced: boolean;
  readonly now: number;
  readonly fetchAccess: (
    accessToken: string,
  ) => Promise<Result<FetchedAccess, UserAccessFetchError>>;
}

type RefreshOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "refreshed" }
  | { readonly kind: "failed"; readonly error: UserAccessFetchError };

function isRefreshDue(state: AccessState, forced: boolean, now: number) {
  if (forced) return true;
  if (state.pending) return now - state.checkedAt >= PENDING_RETRY_INTERVAL_MS;
  return (
    now - state.fetchedAt >= ACCESS_REFRESH_INTERVAL_MS &&
    now - state.checkedAt >= ACCESS_RETRY_INTERVAL_MS
  );
}

/**
 * Re-fetches the user's access when it is due. A failed refresh keeps the
 * current access for at most one more interval and then drops it to nothing,
 * so access only ever grows through a successful fetch. A requested refresh
 * that fails, or one that fails when the access expires before the next
 * regular retry, stays pending and is retried within seconds until it
 * succeeds or fails in a way a retry cannot fix. The state comes from
 * the client's cookie, so limits on how often GitHub is called belong to the
 * fetcher, not to this state.
 */
export async function refreshAccessState(
  input: RefreshAccessInput,
): Promise<{ state: AccessState; outcome: RefreshOutcome }> {
  const { state, accessToken, forced, now, fetchAccess } = input;
  const expired = now - state.fetchedAt >= 2 * ACCESS_REFRESH_INTERVAL_MS;
  const current = expired ? { ...state, access: EMPTY_USER_ACCESS } : state;

  if (!isRefreshDue(state, forced, now) || !accessToken) {
    return { state: current, outcome: { kind: "unchanged" } };
  }

  const result = await fetchAccess(accessToken);
  if (result.success) {
    return {
      state: {
        access: result.data.access,
        fetchedAt: result.data.fetchedAt,
        checkedAt: now,
        pending: false,
      },
      outcome: { kind: "refreshed" },
    };
  }
  // Access that is gone, or will be before the next regular retry, must not
  // look like "no installations" while GitHub is failing.
  const expiresBeforeNextRetry =
    now + ACCESS_RETRY_INTERVAL_MS - state.fetchedAt >=
    2 * ACCESS_REFRESH_INTERVAL_MS;
  return {
    state: {
      ...current,
      checkedAt: now,
      pending:
        result.error.kind !== "permanent" &&
        (state.pending || forced || expiresBeforeNextRetry),
    },
    outcome: { kind: "failed", error: result.error },
  };
}
