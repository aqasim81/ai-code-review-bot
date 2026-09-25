import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_REFRESH_INTERVAL_MS,
  type AccessState,
  type FetchedAccess,
  refreshAccessState,
} from "@/lib/github/access-refresh";
import { EMPTY_USER_ACCESS } from "@/lib/github/repository-access";
import type { UserAccess, UserAccessFetchError } from "@/types/access";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

const MINUTE = 60_000;
const OLD_ACCESS: UserAccess = {
  githubInstallationIds: [10],
  accessibleGithubRepoIds: [1, 2],
  manageableGithubRepoIds: [1],
  truncated: false,
};
const NARROWER_ACCESS: UserAccess = {
  githubInstallationIds: [10],
  accessibleGithubRepoIds: [2],
  manageableGithubRepoIds: [],
  truncated: false,
};
const FETCHED_AT = 1_000_000_000_000;
const SERVER_ERROR: UserAccessFetchError = {
  kind: "retryable",
  message: "Bad Gateway",
};
const RATE_LIMITED: UserAccessFetchError = {
  kind: "rate-limited",
  message: "API rate limit exceeded",
};
const TOKEN_REVOKED: UserAccessFetchError = {
  kind: "permanent",
  message: "Bad credentials",
};

type FetchAccess = (
  accessToken: string,
) => Promise<Result<FetchedAccess, UserAccessFetchError>>;

function stateFetchedAt(fetchedAt: number, checkedAt = fetchedAt): AccessState {
  return { access: OLD_ACCESS, fetchedAt, checkedAt, pending: false };
}

function fetchFailingWith(error: UserAccessFetchError) {
  return vi.fn<FetchAccess>().mockResolvedValue(err(error));
}

function fetchSucceedingAt(fetchedAt: number) {
  return vi
    .fn<FetchAccess>()
    .mockResolvedValue(ok({ access: NARROWER_ACCESS, fetchedAt }));
}

function refreshAt(
  now: number,
  options: {
    state?: AccessState;
    forced?: boolean;
    accessToken?: string | undefined;
    fetchAccess?: ReturnType<typeof vi.fn<FetchAccess>>;
  } = {},
) {
  const fetchAccess = options.fetchAccess ?? fetchSucceedingAt(now);
  const promise = refreshAccessState({
    state: options.state ?? stateFetchedAt(FETCHED_AT),
    accessToken: "accessToken" in options ? options.accessToken : "token",
    forced: options.forced ?? false,
    now,
    fetchAccess,
  });
  return { promise, fetchAccess };
}

describe("refreshAccessState", () => {
  it("does not fetch while the access is fresh", async () => {
    const { promise, fetchAccess } = refreshAt(FETCHED_AT + 4 * MINUTE);

    expect(await promise).toEqual({
      state: stateFetchedAt(FETCHED_AT),
      outcome: { kind: "unchanged" },
    });
    expect(fetchAccess).not.toHaveBeenCalled();
  });

  it("replaces the access once it is due, including narrowing it", async () => {
    const now = FETCHED_AT + ACCESS_REFRESH_INTERVAL_MS;
    const { promise } = refreshAt(now);

    expect(await promise).toEqual({
      state: {
        access: NARROWER_ACCESS,
        fetchedAt: now,
        checkedAt: now,
        pending: false,
      },
      outcome: { kind: "refreshed" },
    });
  });

  it("records when a shared result was actually fetched, not when it was reused", async () => {
    const now = FETCHED_AT + 6 * MINUTE;
    const { promise } = refreshAt(now, {
      fetchAccess: fetchSucceedingAt(now - 20_000),
    });

    expect((await promise).state.fetchedAt).toBe(now - 20_000);
  });

  it("keeps the old access after one failed refresh and reports the error", async () => {
    const now = FETCHED_AT + 6 * MINUTE;
    const { promise } = refreshAt(now, {
      fetchAccess: fetchFailingWith(SERVER_ERROR),
    });

    expect(await promise).toEqual({
      state: {
        access: OLD_ACCESS,
        fetchedAt: FETCHED_AT,
        checkedAt: now,
        pending: false,
      },
      outcome: { kind: "failed", error: SERVER_ERROR },
    });
  });

  it("waits a minute before retrying a failed refresh", async () => {
    const { fetchAccess } = refreshAt(FETCHED_AT + 7 * MINUTE, {
      state: stateFetchedAt(FETCHED_AT, FETCHED_AT + 6.5 * MINUTE),
    });

    expect(fetchAccess).not.toHaveBeenCalled();
  });

  it("drops the access to nothing once it is two intervals old without a successful refresh", async () => {
    const { promise } = refreshAt(FETCHED_AT + 10 * MINUTE, {
      fetchAccess: fetchFailingWith(SERVER_ERROR),
    });

    expect((await promise).state.access).toEqual(EMPTY_USER_ACCESS);
  });

  it("drops stale access even when a retry is not yet allowed", async () => {
    const { promise, fetchAccess } = refreshAt(FETCHED_AT + 10 * MINUTE, {
      state: stateFetchedAt(FETCHED_AT, FETCHED_AT + 9.5 * MINUTE),
    });

    expect((await promise).state.access).toEqual(EMPTY_USER_ACCESS);
    expect(fetchAccess).not.toHaveBeenCalled();
  });

  it("refreshes a forced request even when the access is fresh", async () => {
    const { promise, fetchAccess } = refreshAt(FETCHED_AT + MINUTE, {
      forced: true,
    });

    expect((await promise).state.access).toEqual(NARROWER_ACCESS);
    expect(fetchAccess).toHaveBeenCalledOnce();
  });

  it("refreshes a token from before this change right away", async () => {
    const { fetchAccess } = refreshAt(FETCHED_AT, {
      state: {
        access: EMPTY_USER_ACCESS,
        fetchedAt: 0,
        checkedAt: 0,
        pending: false,
      },
    });

    expect(fetchAccess).toHaveBeenCalledOnce();
  });

  it("cannot refresh without a user token and lets the access expire", async () => {
    const { promise, fetchAccess } = refreshAt(FETCHED_AT + 10 * MINUTE, {
      accessToken: undefined,
    });

    expect(await promise).toEqual({
      state: {
        access: EMPTY_USER_ACCESS,
        fetchedAt: FETCHED_AT,
        checkedAt: FETCHED_AT,
        pending: false,
      },
      outcome: { kind: "unchanged" },
    });
    expect(fetchAccess).not.toHaveBeenCalled();
  });
});

// A refresh the user asked for (sign-in, or right after installing the app)
// that fails in a way a retry can fix stays due, and is retried within
// seconds rather than at the next regular refresh (#118).
describe("refreshAccessState after a requested refresh fails", () => {
  const SIGN_IN_STATE: AccessState = {
    access: EMPTY_USER_ACCESS,
    fetchedAt: 0,
    checkedAt: 0,
    pending: false,
  };

  it("marks a failed sign-in refresh as pending", async () => {
    const { promise } = refreshAt(FETCHED_AT, {
      state: SIGN_IN_STATE,
      forced: true,
      fetchAccess: fetchFailingWith(SERVER_ERROR),
    });

    expect(await promise).toEqual({
      state: { ...SIGN_IN_STATE, checkedAt: FETCHED_AT, pending: true },
      outcome: { kind: "failed", error: SERVER_ERROR },
    });
  });

  it("retries a pending refresh after a few seconds, not a minute", async () => {
    const pendingState = {
      ...SIGN_IN_STATE,
      checkedAt: FETCHED_AT,
      pending: true,
    };

    const early = refreshAt(FETCHED_AT + 4_000, { state: pendingState });
    const due = refreshAt(FETCHED_AT + 5_000, { state: pendingState });
    await Promise.all([early.promise, due.promise]);

    expect(early.fetchAccess).not.toHaveBeenCalled();
    expect(due.fetchAccess).toHaveBeenCalledOnce();
  });

  it("keeps retrying a failed refresh after installing even though the old access is fresh", async () => {
    const afterInstall = await refreshAt(FETCHED_AT + MINUTE, {
      forced: true,
      fetchAccess: fetchFailingWith(SERVER_ERROR),
    }).promise;
    expect(afterInstall.state.access).toEqual(OLD_ACCESS);
    expect(afterInstall.state.pending).toBe(true);

    const retry = refreshAt(FETCHED_AT + MINUTE + 5_000, {
      state: afterInstall.state,
    });

    expect((await retry.promise).state).toEqual({
      access: NARROWER_ACCESS,
      fetchedAt: FETCHED_AT + MINUTE + 5_000,
      checkedAt: FETCHED_AT + MINUTE + 5_000,
      pending: false,
    });
  });

  it("stays pending through a rate limit", async () => {
    const { promise } = refreshAt(FETCHED_AT, {
      state: SIGN_IN_STATE,
      forced: true,
      fetchAccess: fetchFailingWith(RATE_LIMITED),
    });

    expect((await promise).state.pending).toBe(true);
  });

  it("stops retrying early when a retry cannot help", async () => {
    const { promise } = refreshAt(FETCHED_AT, {
      state: { ...SIGN_IN_STATE, checkedAt: FETCHED_AT - 5_000, pending: true },
      fetchAccess: fetchFailingWith(TOKEN_REVOKED),
    });

    expect((await promise).state.pending).toBe(false);
  });

  it("does not mark a failed regular refresh as pending", async () => {
    const { promise } = refreshAt(FETCHED_AT + 6 * MINUTE, {
      fetchAccess: fetchFailingWith(SERVER_ERROR),
    });

    expect((await promise).state.pending).toBe(false);
  });
});
