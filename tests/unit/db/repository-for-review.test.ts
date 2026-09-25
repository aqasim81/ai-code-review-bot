import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  installation: { findUnique: vi.fn() },
  repository: { upsert: vi.fn() },
}));

vi.mock("@/lib/db/prisma-client", () => ({ prisma: prismaMock }));

import { findOrCreateRepositoryForReview } from "@/lib/db/queries";

const INPUT = {
  githubInstallationId: 12345,
  githubRepoId: 555,
  fullName: "acme/renamed-app",
};

describe("findOrCreateRepositoryForReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.repository.upsert.mockResolvedValue({
      id: "repo-1",
      isEnabled: true,
    });
  });

  it("returns nothing for an installation that is not active", async () => {
    prismaMock.installation.findUnique.mockResolvedValue({
      id: "inst-1",
      status: "SUSPENDED",
    });

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
    expect(prismaMock.repository.upsert).not.toHaveBeenCalled();
  });

  it("returns nothing for an unknown installation", async () => {
    prismaMock.installation.findUnique.mockResolvedValue(null);

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
  });

  it("matches by GitHub repository ID under the job's installation and follows renames", async () => {
    prismaMock.installation.findUnique.mockResolvedValue({
      id: "inst-1",
      status: "ACTIVE",
    });

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(prismaMock.installation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { githubInstallationId: 12345 } }),
    );
    expect(prismaMock.repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          installationId_githubRepoId: {
            installationId: "inst-1",
            githubRepoId: 555,
          },
        },
        update: { fullName: "acme/renamed-app" },
        create: {
          installationId: "inst-1",
          githubRepoId: 555,
          fullName: "acme/renamed-app",
        },
      }),
    );
    expect(result).toEqual({
      success: true,
      data: { id: "repo-1", isEnabled: true },
    });
  });

  it("returns an error when the database fails", async () => {
    prismaMock.installation.findUnique.mockRejectedValue(new Error("down"));

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({
      success: false,
      error: "Failed to find repository: down",
    });
  });
});
