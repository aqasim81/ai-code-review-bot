import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  installation: { findUnique: vi.fn() },
  repository: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/db/prisma-client", () => ({ prisma: prismaMock }));

import { Prisma } from "@/generated/prisma/client";
import { findOrCreateRepositoryForReview } from "@/lib/db/queries";

const INPUT = {
  githubInstallationId: 12345,
  githubRepoId: 555,
  fullName: "acme/renamed-app",
};
const KEY = {
  installationId_githubRepoId: { installationId: "inst-1", githubRepoId: 555 },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    isEnabled: true,
    fullName: "acme/renamed-app",
    removedAt: null,
    ...overrides,
  };
}

describe("findOrCreateRepositoryForReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.installation.findUnique.mockResolvedValue({
      id: "inst-1",
      status: "ACTIVE",
    });
  });

  it("returns nothing for an installation that is not active", async () => {
    prismaMock.installation.findUnique.mockResolvedValue({
      id: "inst-1",
      status: "SUSPENDED",
    });

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
    expect(prismaMock.repository.findUnique).not.toHaveBeenCalled();
  });

  it("returns nothing for an unknown installation", async () => {
    prismaMock.installation.findUnique.mockResolvedValue(null);

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
  });

  it("matches by GitHub repository ID under the job's installation and follows renames", async () => {
    prismaMock.repository.findUnique.mockResolvedValue(
      row({ fullName: "acme/old-name" }),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(prismaMock.repository.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: KEY }),
    );
    expect(prismaMock.repository.update).toHaveBeenCalledWith({
      where: KEY,
      data: { fullName: "acme/renamed-app" },
    });
    expect(result).toEqual({
      success: true,
      data: { id: "repo-1", isEnabled: true },
    });
  });

  it("never brings back a repository removed from the installation", async () => {
    prismaMock.repository.findUnique.mockResolvedValue(
      row({ removedAt: new Date() }),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
    expect(prismaMock.repository.create).not.toHaveBeenCalled();
    expect(prismaMock.repository.update).not.toHaveBeenCalled();
  });

  it("creates the row when the repository has none yet", async () => {
    prismaMock.repository.findUnique.mockResolvedValue(null);
    prismaMock.repository.create.mockResolvedValue(row());

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(prismaMock.repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          installationId: "inst-1",
          githubRepoId: 555,
          fullName: "acme/renamed-app",
        },
      }),
    );
    expect(result.success && result.data?.id).toBe("repo-1");
  });

  it("reads the other job's row when two jobs create it at once", async () => {
    prismaMock.repository.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ id: "repo-winner" }));
    prismaMock.repository.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7",
      }),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({
      success: true,
      data: { id: "repo-winner", isEnabled: true },
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
