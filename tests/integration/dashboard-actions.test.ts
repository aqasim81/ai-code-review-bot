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
import { err, ok } from "@/types/results";

const REPO_ID = "5f0c6a3e-8b8e-4f7c-9a52-2f6d6f1d2a11";
const OTHER_REPO_ID = "9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e";

const REFUSED_WITHOUT_PERMISSION = {
  success: false,
  error: expect.stringContaining("admin or maintain"),
};

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
    id: REPO_ID as RepositoryId,
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

    const result = await toggleRepositoryEnabledAction(REPO_ID, false);

    expect(result).toEqual({ success: true });
    expect(updateRepositoryEnabled).toHaveBeenCalledWith(
      REPO_ID,
      false,
      ACCESS,
    );
  });

  it("refuses a read-only user and never writes", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(
      repositoryWithGithubId(2),
    );

    const toggle = await toggleRepositoryEnabledAction(REPO_ID, false);
    const save = await saveRepositorySettingsAction(
      REPO_ID,
      validSettingsForm(),
    );

    expect(toggle).toEqual(REFUSED_WITHOUT_PERMISSION);
    expect(save).toEqual(REFUSED_WITHOUT_PERMISSION);
    expect(updateRepositoryEnabled).not.toHaveBeenCalled();
    expect(updateRepositorySettings).not.toHaveBeenCalled();
  });

  it("reports a repository outside the user's scope as unauthorized", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(ok(null));

    const result = await toggleRepositoryEnabledAction(OTHER_REPO_ID, true);

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(updateRepositoryEnabled).not.toHaveBeenCalled();
  });

  it("rejects arguments the UI never sends before touching the database", async () => {
    const objectId = await toggleRepositoryEnabledAction(
      { not: "" } as unknown as string,
      false,
    );
    const notBoolean = await toggleRepositoryEnabledAction(
      REPO_ID,
      "false" as unknown as boolean,
    );
    const notUuid = await saveRepositorySettingsAction(
      "repo-1",
      validSettingsForm(),
    );

    for (const result of [objectId, notBoolean, notUuid]) {
      expect(result).toEqual({ success: false, error: "Unauthorized" });
    }
    expect(findAccessibleRepositoryById).not.toHaveBeenCalled();
  });

  it("refuses when there is no session", async () => {
    mockedAuth.mockResolvedValue(null);

    const result = await saveRepositorySettingsAction(
      REPO_ID,
      validSettingsForm(),
    );

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(findAccessibleRepositoryById).not.toHaveBeenCalled();
  });

  it("shows a generic message instead of database detail when saving fails", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(
      repositoryWithGithubId(1),
    );
    vi.mocked(updateRepositoryEnabled).mockResolvedValue(
      err(
        "Failed to update repository: Can't reach database server at db:5432",
      ),
    );

    const result = await toggleRepositoryEnabledAction(REPO_ID, true);

    expect(result).toEqual({
      success: false,
      error: "Could not save the change. Please try again.",
    });
  });

  it("shows a generic message instead of database detail when saving settings fails", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(
      repositoryWithGithubId(1),
    );
    vi.mocked(updateRepositorySettings).mockResolvedValue(
      err("Failed to update repository settings: connection refused"),
    );

    const result = await saveRepositorySettingsAction(
      REPO_ID,
      validSettingsForm(),
    );

    expect(result).toEqual({
      success: false,
      error: "Could not save the change. Please try again.",
    });
  });

  it("refuses when the scoped update matches no repository", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(
      repositoryWithGithubId(1),
    );
    vi.mocked(updateRepositorySettings).mockResolvedValue(ok(false));

    const result = await saveRepositorySettingsAction(
      REPO_ID,
      validSettingsForm(),
    );

    expect(result).toEqual(REFUSED_WITHOUT_PERMISSION);
  });
});
