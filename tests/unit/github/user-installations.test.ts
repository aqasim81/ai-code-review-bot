import { beforeEach, describe, expect, it, vi } from "vitest";

const octokitMocks = vi.hoisted(() => ({
  listInstallationsForAuthenticatedUser: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    apps = {
      listInstallationsForAuthenticatedUser:
        octokitMocks.listInstallationsForAuthenticatedUser,
    };
    paginate = octokitMocks.paginate;
  },
}));

import { fetchUserInstallationIds } from "@/lib/github/user-installations";

function installation(id: number) {
  return { id, account: { login: `org-${id}`, type: "Organization" } };
}

describe("fetchUserInstallationIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the IDs of installations from every page", async () => {
    const installations = Array.from({ length: 130 }, (_, index) =>
      installation(index + 1),
    );
    octokitMocks.paginate.mockResolvedValueOnce(installations);

    const result = await fetchUserInstallationIds("user-token");

    expect(result).toEqual({
      success: true,
      data: installations.map((item) => item.id),
    });
  });

  it("pages through the installations endpoint 100 at a time", async () => {
    octokitMocks.paginate.mockResolvedValueOnce([]);

    await fetchUserInstallationIds("user-token");

    expect(octokitMocks.paginate).toHaveBeenCalledWith(
      octokitMocks.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );
  });

  it("returns an error when GitHub rejects the request", async () => {
    octokitMocks.paginate.mockRejectedValueOnce(new Error("Bad credentials"));

    const result = await fetchUserInstallationIds("user-token");

    expect(result).toEqual({
      success: false,
      error: "Failed to fetch user installations: Bad credentials",
    });
  });
});
