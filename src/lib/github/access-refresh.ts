import { EMPTY_USER_ACCESS } from "@/lib/github/repository-access";
import type { UserAccess } from "@/types/access";
import type { Result } from "@/types/results";

export const ACCESS_REFRESH_INTERVAL_MS = 5 * 60_000;
const ACCESS_RETRY_INTERVAL_MS = 60_000;
// A forced refresh can be requested by the client, so cap how often it hits GitHub.
const FORCED_REFRESH_MIN_INTERVAL_MS = 10_000;

export interface AccessState {
  readonly access: UserAccess;
  /** When access was last fetched successfully (ms epoch, 0 = never). */
  readonly fetchedAt: number;
  /** When a fetch was last attempted (ms epoch, 0 = never). */
  readonly checkedAt: number;
}

interface RefreshAccessInput {
  readonly state: AccessState;
  readonly accessToken: string | undefined;
  readonly forced: boolean;
  readonly now: number;
  readonly fetchAccess: (
    accessToken: string,
  ) => Promise<Result<UserAccess, string>>;
}

function isRefreshDue(state: AccessState, forced: boolean, now: number) {
  const sinceCheck = now - state.checkedAt;
  if (forced) return sinceCheck >= FORCED_REFRESH_MIN_INTERVAL_MS;
  return (
    now - state.fetchedAt >= ACCESS_REFRESH_INTERVAL_MS &&
    sinceCheck >= ACCESS_RETRY_INTERVAL_MS
  );
}

/**
 * Re-fetches the user's access when it is due. A failed refresh keeps the
 * current access for at most one more interval and then drops it to nothing,
 * so access only ever grows through a successful fetch.
 */
export async function refreshAccessState(
  input: RefreshAccessInput,
): Promise<AccessState> {
  const { state, accessToken, forced, now, fetchAccess } = input;
  const expired = now - state.fetchedAt >= 2 * ACCESS_REFRESH_INTERVAL_MS;
  const current = expired ? { ...state, access: EMPTY_USER_ACCESS } : state;

  if (!isRefreshDue(state, forced, now)) return current;
  if (!accessToken) return { ...current, checkedAt: now };

  const result = await fetchAccess(accessToken);
  if (result.success) {
    return { access: result.data, fetchedAt: now, checkedAt: now };
  }
  return { ...current, checkedAt: now };
}
