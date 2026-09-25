import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/queries");

import {
  saveRepositorySettingsAction,
  toggleRepositoryEnabledAction,
} from "@/app/dashboard/actions";
import { auth } from "@/auth";
import {
  findAccessibleRepositoryById,
  updateRepositoryEnabled,
  updateRepositorySettings,
} from "@/lib/db/queries";
import type { RepositoryId } from "@/types/branded";
import { ok } from "@/types/results";

const ACCESS = {
  githubInstallationIds: [10],
  accessibleGithubRepoIds: [1, 2],
  manageableGithubRepoIds: [1],
  truncated: false,
};

// auth() is overloaded (session getter and middleware wrapper); tests only use
// the session getter.
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn>;

function signInWithAccess(): void {
  mockedAuth.mockResolvedValue({
    user: { id: "u1", githubId: 1, login: "dev", avatarUrl: "" },
    access: ACCESS,
    expires: "2099-01-01T00:00:00.000Z",
  });
}

function repositoryWithGithubId(githubRepoId: number) {
  return ok({
    id: "repo-1" as RepositoryId,
    githubRepoId,
    fullName: "acme/app",
    settings: {},
  });
}

function validSettingsForm(): FormData {
  const form = new FormData();
  form.append("enabledCategories", "BUGS");
  form.set("minimumSeverity", "WARNING");
  form.set("customInstructions", "");
  return form;
}

describe("dashboard repository actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInWithAccess();
    vi.mocked(updateRepositoryEnabled).mockResolvedValue(ok(true));
    vi.mocked(updateRepositorySettings).mockResolvedValue(ok(true));
  });

  it("lets a user with admin or maintain permission toggle reviews", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(
      repositoryWithGithubId(1),
    );

    const result = await toggleRepositoryEnabledAction("repo-1", false);

    expect(result).toEqual({ success: true });
    expect(updateRepositoryEnabled).toHaveBeenCalledWith(
      "repo-1",
      false,
      ACCESS,
    );
  });

  it("refuses a read-only user and never writes", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(
      repositoryWithGithubId(2),
    );

    const toggle = await toggleRepositoryEnabledAction("repo-1", false);
    const save = await saveRepositorySettingsAction(
      "repo-1",
      validSettingsForm(),
    );

    expect(toggle.success).toBe(false);
    expect(toggle.error).toContain("admin or maintain");
    expect(save.success).toBe(false);
    expect(updateRepositoryEnabled).not.toHaveBeenCalled();
    expect(updateRepositorySettings).not.toHaveBeenCalled();
  });

  it("reports a repository outside the user's scope as unauthorized", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(ok(null));

    const result = await toggleRepositoryEnabledAction("repo-9", true);

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(updateRepositoryEnabled).not.toHaveBeenCalled();
  });

  it("refuses when there is no session", async () => {
    mockedAuth.mockResolvedValue(null);

    const result = await saveRepositorySettingsAction(
      "repo-1",
      validSettingsForm(),
    );

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(findAccessibleRepositoryById).not.toHaveBeenCalled();
  });

  it("refuses when the scoped update matches no repository", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(
      repositoryWithGithubId(1),
    );
    vi.mocked(updateRepositorySettings).mockResolvedValue(ok(false));

    const result = await saveRepositorySettingsAction(
      "repo-1",
      validSettingsForm(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("admin or maintain");
  });
});
