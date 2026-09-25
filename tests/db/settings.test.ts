import { describe, expect, it } from "vitest";
import { updateRepositorySettings } from "@/lib/db/queries";
import type { AccessScope } from "@/types/access";
import type { RepositoryId } from "@/types/branded";
import { repositorySettingsSchema } from "@/types/settings";
import {
  createActiveRepository,
  GITHUB_INSTALLATION_ID,
  GITHUB_REPO_ID,
  testPrisma,
} from "./database";

const MANAGER_SCOPE: AccessScope = {
  githubInstallationIds: [GITHUB_INSTALLATION_ID],
  accessibleGithubRepoIds: [GITHUB_REPO_ID],
  manageableGithubRepoIds: [GITHUB_REPO_ID],
};

const SETTINGS_FORM = {
  enabledCategories: ["BUGS", "SECURITY"],
  minimumSeverity: "WARNING",
  excludePatterns: ["dist/**"],
  customInstructions: "Be brief.",
};

// Validates and saves the way the dashboard's settings action does.
async function saveSettingsForm(
  repositoryId: RepositoryId,
  form: Record<string, unknown>,
): Promise<"rejected" | "saved" | "failed"> {
  const parsed = repositorySettingsSchema.safeParse(form);
  if (!parsed.success) return "rejected";
  const result = await updateRepositorySettings(
    repositoryId,
    parsed.data,
    MANAGER_SCOPE,
  );
  return result.success && result.data ? "saved" : "failed";
}

async function storedSettings(): Promise<unknown> {
  const repository = await testPrisma.repository.findFirstOrThrow();
  return repository.settings;
}

describe("saving repository settings in Postgres", () => {
  it("saves valid settings", async () => {
    const repositoryId = await createActiveRepository();

    expect(await saveSettingsForm(repositoryId, SETTINGS_FORM)).toBe("saved");
    expect(await storedSettings()).toEqual(SETTINGS_FORM);
  });

  it.each([
    ["customInstructions", { customInstructions: "a\u0000b" }],
    ["excludePatterns", { excludePatterns: ["dist/\u0000**"] }],
  ])(
    "never fails to save settings with NUL in %s: they are rejected before the write (#75)",
    async (_field, change) => {
      const repositoryId = await createActiveRepository();

      const outcome = await saveSettingsForm(repositoryId, {
        ...SETTINGS_FORM,
        ...change,
      });

      expect(outcome).toBe("rejected");
      expect(await storedSettings()).toEqual({});
    },
  );

  it("confirms Postgres jsonb rejects NUL, which is why the form must", async () => {
    const repositoryId = await createActiveRepository();

    const result = await updateRepositorySettings(
      repositoryId,
      { ...SETTINGS_FORM, customInstructions: "a\u0000b" } as never,
      MANAGER_SCOPE,
    );

    expect(result.success).toBe(false);
  });
});
