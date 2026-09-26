import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/user-installations", () => ({
  fetchUserRepositoryAccess: vi.fn(),
}));

import { fetchUserRepositoryAccess } from "@/lib/github/user-installations";
import { err, ok } from "@/types/results";

const ACCESS = {
  githubInstallationIds: [10],
  accessibleGithubRepoIds: [1],
  manageableGithubRepoIds: [],
  truncated: false,
};

async function loadFreshCache() {
  vi.resetModules();
  return import("@/lib/github/user-access-cache");
}

describe("fetchUserRepositoryAccessShared", () => {
  beforeEach(() => {
    vi.mocked(fetchUserRepositoryAccess).mockReset();
    vi.mocked(fetchUserRepositoryAccess).mockResolvedValue(ok(ACCESS));
  });

  it("shares one fetch between regular refreshes within 30 seconds and keeps its fetch time", async () => {
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    await fetchUserRepositoryAccessShared("token", { now: 0, forced: false });
    const reused = await fetchUserRepositoryAccessShared("token", {
      now: 29_000,
      forced: false,
    });

    expect(reused).toEqual(ok({ access: ACCESS, fetchedAt: 0 }));
    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(1);
  });

  it("fetches again once a regular entry is 30 seconds old", async () => {
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    await fetchUserRepositoryAccessShared("token", { now: 0, forced: false });
    await fetchUserRepositoryAccessShared("token", {
      now: 30_000,
      forced: false,
    });

    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(2);
  });

  it("limits forced refreshes to one GitHub fetch per 10 seconds, however often the client asks", async () => {
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    for (const now of [0, 2_000, 5_000, 9_999]) {
      await fetchUserRepositoryAccessShared("token", { now, forced: true });
    }
    await fetchUserRepositoryAccessShared("token", {
      now: 10_000,
      forced: true,
    });

    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(2);
  });

  it("does not let a forced refresh reuse a regular result from moments before", async () => {
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    await fetchUserRepositoryAccessShared("token", { now: 0, forced: false });
    await fetchUserRepositoryAccessShared("token", {
      now: 3_000,
      forced: true,
    });

    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps different users' tokens apart", async () => {
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    await fetchUserRepositoryAccessShared("token-a", { now: 0, forced: false });
    await fetchUserRepositoryAccessShared("token-b", { now: 0, forced: false });

    expect(fetchUserRepositoryAccess).toHaveBeenCalledWith("token-a");
    expect(fetchUserRepositoryAccess).toHaveBeenCalledWith("token-b");
  });

  it("passes a failed fetch through", async () => {
    const revoked = { kind: "permanent", message: "Bad credentials" } as const;
    vi.mocked(fetchUserRepositoryAccess).mockResolvedValue(err(revoked));
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    const result = await fetchUserRepositoryAccessShared("token", {
      now: 0,
      forced: true,
    });

    expect(result).toEqual(err(revoked));
  });

  // A failure a retry can fix is shared only while it is in flight: the next
  // refresh, forced or not, asks GitHub again (#118).
  it.each([true, false])(
    "does not reuse a retryable failure (forced: %s)",
    async (forced) => {
      vi.mocked(fetchUserRepositoryAccess)
        .mockResolvedValueOnce(
          err({ kind: "retryable", message: "Bad Gateway" }),
        )
        .mockResolvedValueOnce(ok(ACCESS));
      const { fetchUserRepositoryAccessShared } = await loadFreshCache();

      await fetchUserRepositoryAccessShared("token", { now: 0, forced });
      const retried = await fetchUserRepositoryAccessShared("token", {
        now: 3_000,
        forced,
      });

      expect(retried).toEqual(ok({ access: ACCESS, fetchedAt: 3_000 }));
      expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(2);
    },
  );

  it("shares one in-flight fetch even when it fails", async () => {
    vi.mocked(fetchUserRepositoryAccess).mockResolvedValue(
      err({ kind: "retryable", message: "Bad Gateway" }),
    );
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    await Promise.all([
      fetchUserRepositoryAccessShared("token", { now: 0, forced: true }),
      fetchUserRepositoryAccessShared("token", { now: 0, forced: true }),
    ]);

    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(1);
  });

  it("reuses a rate-limited failure so a pending retry does not ask GitHub again", async () => {
    vi.mocked(fetchUserRepositoryAccess).mockResolvedValue(
      err({
        kind: "rate-limited",
        message: "API rate limit exceeded",
        retryAt: 60_000,
      }),
    );
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    await fetchUserRepositoryAccessShared("token", { now: 0, forced: true });
    await fetchUserRepositoryAccessShared("token", {
      now: 5_000,
      forced: false,
    });

    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(1);
  });

  // A rate-limited user token can't be used until the limit resets, however
  // often the dashboard asks (#142).
  it("reuses a rate-limited failure until the limit resets, forced or not", async () => {
    const limited = {
      kind: "rate-limited",
      message: "API rate limit exceeded",
      retryAt: 120_000,
    } as const;
    vi.mocked(fetchUserRepositoryAccess)
      .mockResolvedValueOnce(err(limited))
      .mockResolvedValueOnce(ok(ACCESS));
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    await fetchUserRepositoryAccessShared("token", { now: 0, forced: false });
    for (const [now, forced] of [
      [40_000, false],
      [60_000, true],
      [119_999, true],
    ] as const) {
      expect(
        await fetchUserRepositoryAccessShared("token", { now, forced }),
      ).toEqual(err(limited));
    }
    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(1);

    const afterReset = await fetchUserRepositoryAccessShared("token", {
      now: 120_000,
      forced: true,
    });
    expect(afterReset).toEqual(ok({ access: ACCESS, fetchedAt: 120_000 }));
  });
});
