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
    vi.mocked(fetchUserRepositoryAccess).mockResolvedValue(err("revoked"));
    const { fetchUserRepositoryAccessShared } = await loadFreshCache();

    const result = await fetchUserRepositoryAccessShared("token", {
      now: 0,
      forced: true,
    });

    expect(result).toEqual(err("revoked"));
  });
});
