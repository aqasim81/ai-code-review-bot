import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_REFRESH_INTERVAL_MS,
  type AccessState,
  type FetchedAccess,
  refreshAccessState,
} from "@/lib/github/access-refresh";
import { EMPTY_USER_ACCESS } from "@/lib/github/repository-access";
import type { UserAccess } from "@/types/access";
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

type FetchAccess = (
  accessToken: string,
) => Promise<Result<FetchedAccess, string>>;

function stateFetchedAt(fetchedAt: number, checkedAt = fetchedAt): AccessState {
  return { access: OLD_ACCESS, fetchedAt, checkedAt };
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
      state: { access: NARROWER_ACCESS, fetchedAt: now, checkedAt: now },
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
      fetchAccess: vi.fn<FetchAccess>().mockResolvedValue(err("boom")),
    });

    expect(await promise).toEqual({
      state: { access: OLD_ACCESS, fetchedAt: FETCHED_AT, checkedAt: now },
      outcome: { kind: "failed", error: "boom" },
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
      fetchAccess: vi.fn<FetchAccess>().mockResolvedValue(err("boom")),
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
      state: { access: EMPTY_USER_ACCESS, fetchedAt: 0, checkedAt: 0 },
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
      },
      outcome: { kind: "unchanged" },
    });
    expect(fetchAccess).not.toHaveBeenCalled();
  });
});
