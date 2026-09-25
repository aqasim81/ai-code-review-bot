import { EMPTY_USER_ACCESS } from "@/lib/github/repository-access";
import type { UserAccess } from "@/types/access";
import type { Result } from "@/types/results";

export const ACCESS_REFRESH_INTERVAL_MS = 5 * 60_000;
const ACCESS_RETRY_INTERVAL_MS = 60_000;

export interface AccessState {
  readonly access: UserAccess;
  /** When the access in use was fetched from GitHub (ms epoch, 0 = never). */
  readonly fetchedAt: number;
  /** When a refresh was last attempted (ms epoch, 0 = never). */
  readonly checkedAt: number;
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
  ) => Promise<Result<FetchedAccess, string>>;
}

type RefreshOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "refreshed" }
  | { readonly kind: "failed"; readonly error: string };

function isRefreshDue(state: AccessState, forced: boolean, now: number) {
  if (forced) return true;
  return (
    now - state.fetchedAt >= ACCESS_REFRESH_INTERVAL_MS &&
    now - state.checkedAt >= ACCESS_RETRY_INTERVAL_MS
  );
}

/**
 * Re-fetches the user's access when it is due. A failed refresh keeps the
 * current access for at most one more interval and then drops it to nothing,
 * so access only ever grows through a successful fetch. The state comes from
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
      },
      outcome: { kind: "refreshed" },
    };
  }
  return {
    state: { ...current, checkedAt: now },
    outcome: { kind: "failed", error: result.error },
  };
}
