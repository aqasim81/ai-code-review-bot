import type { AccountType } from "@/generated/prisma/client";
import type { InstallationId } from "@/types/branded";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import { prisma } from "./prisma-client";

interface CreateInstallationInput {
  githubInstallationId: number;
  githubAccountLogin: string;
  githubAccountType: AccountType;
}

export async function createInstallation(
  input: CreateInstallationInput,
): Promise<Result<{ id: InstallationId }, string>> {
  try {
    const installation = await prisma.installation.upsert({
      where: { githubInstallationId: input.githubInstallationId },
      update: {
        githubAccountLogin: input.githubAccountLogin,
        githubAccountType: input.githubAccountType,
        status: "ACTIVE",
      },
      create: {
        githubInstallationId: input.githubInstallationId,
        githubAccountLogin: input.githubAccountLogin,
        githubAccountType: input.githubAccountType,
        status: "ACTIVE",
      },
    });
    return ok({ id: installation.id as InstallationId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to create installation: ${message}`);
  }
}

interface CreateRepositoryInput {
  githubRepoId: number;
  fullName: string;
}

export async function createRepositories(
  installationId: InstallationId,
  repositories: CreateRepositoryInput[],
): Promise<Result<{ count: number }, string>> {
  try {
    const results = await prisma.$transaction(
      repositories.map((repo) =>
        prisma.repository.upsert({
          where: {
            installationId_githubRepoId: {
              installationId,
              githubRepoId: repo.githubRepoId,
            },
          },
          update: {
            fullName: repo.fullName,
          },
          create: {
            installationId,
            githubRepoId: repo.githubRepoId,
            fullName: repo.fullName,
          },
        }),
      ),
    );
    return ok({ count: results.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error";
    return err(`Failed to create repositories: ${message}`);
  }
}
