import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockRepository {
  id: number;
  permissions?: { admin: boolean; maintain?: boolean; push: boolean };
}

const github = vi.hoisted(() => ({
  installations: [] as { id: number }[],
  repositoriesByInstallation: new Map<number, MockRepository[]>(),
  pagesServed: 0,
  failInstallationId: null as number | null,
}));

const octokitMocks = vi.hoisted(() => ({
  listInstallationsForAuthenticatedUser: vi.fn(),
  listInstallationReposForAuthenticatedUser: vi.fn(),
}));

type MapPage = (
  response: { data: MockRepository[] },
  done: () => void,
) => MockRepository[];

// Serves pages like Octokit's paginate, honouring the map function's done().
async function paginate(
  endpoint: unknown,
  params: { installation_id?: number; per_page: number },
  mapPage?: MapPage,
): Promise<unknown[]> {
  if (endpoint === octokitMocks.listInstallationsForAuthenticatedUser) {
    return github.installations;
  }
  const installationId = params.installation_id ?? -1;
  if (installationId === github.failInstallationId) {
    throw new Error("Bad credentials");
  }
  const all = github.repositoriesByInstallation.get(installationId) ?? [];
  const results: MockRepository[] = [];
  let stopped = false;
  for (
    let start = 0;
    start < all.length && !stopped;
    start += params.per_page
  ) {
    github.pagesServed += 1;
    const page = all.slice(start, start + params.per_page);
    const mapped = mapPage
      ? mapPage({ data: page }, () => {
          stopped = true;
        })
      : page;
    results.push(...mapped);
  }
  return results;
}

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    apps = octokitMocks;
    paginate = paginate;
  },
}));

import {
  fetchUserRepositoryAccess,
  MAX_SESSION_REPOSITORIES,
} from "@/lib/github/user-installations";

function repositories(
  count: number,
  firstId: number,
  permissions?: MockRepository["permissions"],
): MockRepository[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    ...(permissions ? { permissions } : {}),
  }));
}

const READ_ONLY = { admin: false, push: false };

describe("fetchUserRepositoryAccess", () => {
  beforeEach(() => {
    github.installations = [];
    github.repositoriesByInstallation = new Map();
    github.pagesServed = 0;
    github.failInstallationId = null;
  });

  it("collects accessible and manageable repositories per installation", async () => {
    github.installations = [{ id: 20 }, { id: 10 }];
    github.repositoriesByInstallation.set(10, [
      { id: 1, permissions: { admin: true, push: true } },
      { id: 2, permissions: { admin: false, maintain: true, push: true } },
      { id: 3, permissions: { admin: false, push: true } },
    ]);
    github.repositoriesByInstallation.set(20, [
      { id: 4, permissions: READ_ONLY },
      { id: 5 },
    ]);

    const result = await fetchUserRepositoryAccess("user-token");

    expect(result).toEqual({
      success: true,
      data: {
        githubInstallationIds: [10, 20],
        accessibleGithubRepoIds: [1, 2, 3, 4, 5],
        manageableGithubRepoIds: [1, 2],
        truncated: false,
      },
    });
  });

  it("leaves out installations where the user can access no repository", async () => {
    github.installations = [{ id: 10 }, { id: 20 }];
    github.repositoriesByInstallation.set(20, [
      { id: 7, permissions: READ_ONLY },
    ]);

    const result = await fetchUserRepositoryAccess("user-token");

    expect(result.success && result.data.githubInstallationIds).toEqual([20]);
  });

  it("stops at the session cap, stops paging early and marks the access truncated", async () => {
    github.installations = [{ id: 10 }, { id: 20 }];
    github.repositoriesByInstallation.set(10, repositories(120, 1, READ_ONLY));
    github.repositoriesByInstallation.set(
      20,
      repositories(500, 1000, READ_ONLY),
    );

    const result = await fetchUserRepositoryAccess("user-token");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.accessibleGithubRepoIds).toHaveLength(
      MAX_SESSION_REPOSITORIES,
    );
    expect(result.data.githubInstallationIds).toEqual([10, 20]);
    expect(result.data.truncated).toBe(true);
    // 2 pages for installation 10, then 1 page for installation 20 before done().
    expect(github.pagesServed).toBe(3);
  });

  it("marks the access truncated when further installations are left out", async () => {
    github.installations = [{ id: 10 }, { id: 20 }];
    github.repositoriesByInstallation.set(
      10,
      repositories(MAX_SESSION_REPOSITORIES, 1, READ_ONLY),
    );
    github.repositoriesByInstallation.set(20, repositories(1, 9000, READ_ONLY));

    const result = await fetchUserRepositoryAccess("user-token");

    expect(result.success && result.data.githubInstallationIds).toEqual([10]);
    expect(result.success && result.data.truncated).toBe(true);
  });

  it("grants nothing when any request fails", async () => {
    github.installations = [{ id: 10 }, { id: 20 }];
    github.repositoriesByInstallation.set(10, repositories(3, 1, READ_ONLY));
    github.failInstallationId = 20;

    const result = await fetchUserRepositoryAccess("user-token");

    expect(result).toEqual({
      success: false,
      error: "Failed to fetch user repository access: Bad credentials",
    });
  });
});
