import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/user-installations", () => ({
  fetchUserRepositoryAccess: vi.fn(),
}));

import { fetchUserRepositoryAccess } from "@/lib/github/user-installations";
import { ok } from "@/types/results";

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

describe("fetchUserRepositoryAccessCached", () => {
  beforeEach(() => {
    vi.mocked(fetchUserRepositoryAccess).mockReset();
    vi.mocked(fetchUserRepositoryAccess).mockResolvedValue(ok(ACCESS));
  });

  it("shares one fetch between calls within 30 seconds", async () => {
    const { fetchUserRepositoryAccessCached } = await loadFreshCache();

    const first = fetchUserRepositoryAccessCached("token", 0);
    const second = fetchUserRepositoryAccessCached("token", 29_000);

    expect(await first).toEqual(ok(ACCESS));
    expect(await second).toEqual(ok(ACCESS));
    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the entry expires", async () => {
    const { fetchUserRepositoryAccessCached } = await loadFreshCache();

    await fetchUserRepositoryAccessCached("token", 0);
    await fetchUserRepositoryAccessCached("token", 30_000);

    expect(fetchUserRepositoryAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps different users' tokens apart", async () => {
    const { fetchUserRepositoryAccessCached } = await loadFreshCache();

    await fetchUserRepositoryAccessCached("token-a", 0);
    await fetchUserRepositoryAccessCached("token-b", 0);

    expect(fetchUserRepositoryAccess).toHaveBeenCalledWith("token-a");
    expect(fetchUserRepositoryAccess).toHaveBeenCalledWith("token-b");
  });
});
