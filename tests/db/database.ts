import { prisma } from "@/lib/db/prisma-client";
import { createInstallationWithRepositories } from "@/lib/db/queries";
import type { RepositoryId } from "@/types/branded";

// Test-only access to the database, to arrange rows and read back what the
// queries under test wrote.
export const testPrisma = prisma;

export async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE review_comments, reviews, repositories, installations, jobs CASCADE",
  );
}

export async function disconnectTestDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export const GITHUB_INSTALLATION_ID = 1001;
export const GITHUB_REPO_ID = 2002;

/** An active installation with one repository; returns the repository's id. */
export async function createActiveRepository(): Promise<RepositoryId> {
  const created = await createInstallationWithRepositories(
    {
      githubInstallationId: GITHUB_INSTALLATION_ID,
      githubAccountLogin: "octo-org",
      githubAccountType: "ORG",
    },
    [{ githubRepoId: GITHUB_REPO_ID, fullName: "octo-org/repo" }],
  );
  if (!created.success) throw new Error(created.error);
  const repository = await prisma.repository.findFirstOrThrow({
    select: { id: true },
  });
  return repository.id as RepositoryId;
}
