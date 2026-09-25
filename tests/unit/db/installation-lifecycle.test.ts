import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  installation: { upsert: vi.fn() },
  repository: { upsert: vi.fn() },
}));
const prismaMock = vi.hoisted(() => ({
  installation: { updateMany: vi.fn() },
  repository: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db/prisma-client", () => ({ prisma: prismaMock }));

import {
  addRepositoriesToInstallation,
  createInstallationWithRepositories,
  removeRepositoriesFromInstallation,
  setInstallationSuspended,
} from "@/lib/db/queries";

const INSTALLATION = {
  githubInstallationId: 12345,
  githubAccountLogin: "acme",
  githubAccountType: "ORG" as const,
};

describe("installation lifecycle queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    );
    tx.installation.upsert.mockResolvedValue({ id: "inst-1" });
    tx.repository.upsert.mockResolvedValue({});
  });

  it("adds repositories without reviving a suspended or deleted installation", async () => {
    const result = await addRepositoriesToInstallation(INSTALLATION, [
      { githubRepoId: 200, fullName: "acme/new-repo" },
    ]);

    expect(result).toEqual({ success: true, data: { repositoryCount: 1 } });
    const upsert = tx.installation.upsert.mock.calls[0]?.[0];
    expect(upsert?.update).not.toHaveProperty("status");
    expect(upsert?.create).toMatchObject({ status: "ACTIVE" });
    expect(tx.repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          installationId_githubRepoId: {
            installationId: "inst-1",
            githubRepoId: 200,
          },
        },
      }),
    );
  });

  it("reactivates the installation when it is created again", async () => {
    await createInstallationWithRepositories(INSTALLATION, []);

    expect(tx.installation.upsert.mock.calls[0]?.[0]?.update).toMatchObject({
      status: "ACTIVE",
    });
  });

  it("removes only the named repositories of that installation", async () => {
    prismaMock.repository.deleteMany.mockResolvedValue({ count: 2 });

    const result = await removeRepositoriesFromInstallation(12345, [300, 301]);

    expect(prismaMock.repository.deleteMany).toHaveBeenCalledWith({
      where: {
        githubRepoId: { in: [300, 301] },
        installation: { githubInstallationId: 12345 },
      },
    });
    expect(result).toEqual({ success: true, data: { removedCount: 2 } });
  });

  it("suspends and resumes an installation but never revives a deleted one", async () => {
    prismaMock.installation.updateMany.mockResolvedValue({ count: 1 });

    await setInstallationSuspended(12345, true);
    await setInstallationSuspended(12345, false);

    expect(prismaMock.installation.updateMany).toHaveBeenNthCalledWith(1, {
      where: { githubInstallationId: 12345, status: { not: "DELETED" } },
      data: { status: "SUSPENDED" },
    });
    expect(prismaMock.installation.updateMany).toHaveBeenNthCalledWith(2, {
      where: { githubInstallationId: 12345, status: { not: "DELETED" } },
      data: { status: "ACTIVE" },
    });
  });

  it("returns an error when the database fails", async () => {
    prismaMock.repository.deleteMany.mockRejectedValue(new Error("down"));

    const result = await removeRepositoriesFromInstallation(12345, [300]);

    expect(result).toEqual({
      success: false,
      error: "Failed to remove repositories: down",
    });
  });
});
