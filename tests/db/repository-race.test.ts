import { describe, expect, it } from "vitest";
import {
  createInstallationWithRepositories,
  findOrCreateRepositoryForReview,
} from "@/lib/db/queries";
import { GITHUB_INSTALLATION_ID, testPrisma } from "./database";

const NEW_REPOSITORY = {
  githubInstallationId: GITHUB_INSTALLATION_ID,
  githubRepoId: 3003,
  fullName: "octo-org/new-repo",
};

describe("creating a repository row for a review in Postgres", () => {
  it("gives concurrent jobs for a new repository the same single row", async () => {
    const installed = await createInstallationWithRepositories(
      {
        githubInstallationId: GITHUB_INSTALLATION_ID,
        githubAccountLogin: "octo-org",
        githubAccountType: "ORG",
      },
      [],
    );
    expect(installed.success).toBe(true);

    // Open pool connections first; otherwise the lazily opened pool runs the
    // jobs' queries one after another and they never race.
    await Promise.all(
      Array.from(
        { length: 8 },
        () => testPrisma.$executeRaw`SELECT pg_sleep(0.05)`,
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        findOrCreateRepositoryForReview(NEW_REPOSITORY),
      ),
    );

    const ids = results.map((result) =>
      result.success ? result.data?.id : result.error,
    );
    const rows = await testPrisma.repository.findMany();
    expect(rows).toHaveLength(1);
    expect(ids).toEqual(Array(8).fill(rows[0]?.id));
  });
});
