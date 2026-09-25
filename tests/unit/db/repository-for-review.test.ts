import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  installation: { findUnique: vi.fn() },
  repository: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/db/prisma-client", () => ({ prisma: prismaMock }));

import { Prisma } from "@/generated/prisma/client";
import { findOrCreateRepositoryForReview } from "@/lib/db/queries";
import { mergeWithDefaults } from "@/types/settings";

const DEFAULT_SETTINGS = mergeWithDefaults({});

const INPUT = {
  githubInstallationId: 12345,
  githubRepoId: 555,
  fullName: "acme/renamed-app",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    isEnabled: true,
    fullName: "acme/renamed-app",
    removedAt: null,
    settings: {},
    ...overrides,
  };
}

function foundRow(
  overrides: Record<string, unknown> = {},
  installationStatus = "ACTIVE",
) {
  return { ...row(overrides), installation: { status: installationStatus } };
}

describe("findOrCreateRepositoryForReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.repository.findFirst.mockResolvedValue(null);
    prismaMock.installation.findUnique.mockResolvedValue({
      id: "inst-1",
      status: "ACTIVE",
    });
  });

  it("returns nothing for a known repository under an installation that is not active", async () => {
    prismaMock.repository.findFirst.mockResolvedValue(
      foundRow({}, "SUSPENDED"),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
    expect(prismaMock.repository.update).not.toHaveBeenCalled();
  });

  it("never creates a repository under an installation that is not active", async () => {
    prismaMock.installation.findUnique.mockResolvedValue({
      id: "inst-1",
      status: "SUSPENDED",
    });

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
    expect(prismaMock.repository.create).not.toHaveBeenCalled();
  });

  it("returns nothing for an unknown installation", async () => {
    prismaMock.installation.findUnique.mockResolvedValue(null);

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
  });

  it("matches by GitHub repository ID under the job's installation and follows renames", async () => {
    prismaMock.repository.findFirst.mockResolvedValue(
      foundRow({ fullName: "acme/old-name" }),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(prismaMock.repository.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          githubRepoId: 555,
          installation: { githubInstallationId: 12345 },
        },
      }),
    );
    expect(prismaMock.repository.update).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { fullName: "acme/renamed-app" },
    });
    expect(result).toEqual({
      success: true,
      data: { id: "repo-1", isEnabled: true, settings: DEFAULT_SETTINGS },
    });
  });

  it("never brings back a repository removed from the installation", async () => {
    prismaMock.repository.findFirst.mockResolvedValue(
      foundRow({ removedAt: new Date() }),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({ success: true, data: null });
    expect(prismaMock.repository.create).not.toHaveBeenCalled();
    expect(prismaMock.repository.update).not.toHaveBeenCalled();
  });

  it("creates the row when the repository has none yet", async () => {
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
    prismaMock.repository.findUnique.mockResolvedValue(
      row({ id: "repo-winner" }),
    );
    prismaMock.repository.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7",
      }),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({
      success: true,
      data: {
        id: "repo-winner",
        isEnabled: true,
        settings: DEFAULT_SETTINGS,
      },
    });
  });

  it("returns the stored settings, with invalid fields replaced by defaults", async () => {
    prismaMock.repository.findFirst.mockResolvedValue(
      foundRow({
        settings: { minimumSeverity: "CRITICAL", excludePatterns: "dist" },
      }),
    );

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(prismaMock.repository.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ settings: true }),
      }),
    );
    expect(result).toEqual({
      success: true,
      data: {
        id: "repo-1",
        isEnabled: true,
        settings: { ...DEFAULT_SETTINGS, minimumSeverity: "CRITICAL" },
      },
    });
  });

  it("returns an error when the database fails", async () => {
    prismaMock.repository.findFirst.mockRejectedValue(new Error("down"));

    const result = await findOrCreateRepositoryForReview(INPUT);

    expect(result).toEqual({
      success: false,
      error: "Failed to find repository: down",
    });
  });
});
