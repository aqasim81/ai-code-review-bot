"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {
  findAccessibleRepositoryById,
  updateRepositoryEnabled,
  updateRepositorySettings,
} from "@/lib/db/queries";
import { canManageRepository } from "@/lib/github/repository-access";
import type { AccessScope } from "@/types/access";
import type { RepositoryId } from "@/types/branded";
import { repositorySettingsSchema } from "@/types/settings";

type ActionResult = { success: boolean; error?: string };

const UNAUTHORIZED: ActionResult = { success: false, error: "Unauthorized" };
const FORBIDDEN: ActionResult = {
  success: false,
  error: "You need admin or maintain permission on this repository.",
};

/**
 * Returns the caller's access scope when they can manage the repository. A
 * repository outside their scope is reported as unauthorized, so the answer
 * does not reveal that it exists.
 */
async function authorizeRepositoryManagement(
  repositoryId: RepositoryId,
): Promise<{ scope: AccessScope } | ActionResult> {
  const session = await auth();
  if (!session) return UNAUTHORIZED;

  const repo = await findAccessibleRepositoryById(repositoryId, session.access);
  if (!repo.success || !repo.data) return UNAUTHORIZED;
  if (!canManageRepository(session.access, repo.data.githubRepoId)) {
    return FORBIDDEN;
  }
  return { scope: session.access };
}

export async function toggleRepositoryEnabledAction(
  repositoryId: string,
  isEnabled: boolean,
): Promise<ActionResult> {
  const authorization = await authorizeRepositoryManagement(
    repositoryId as RepositoryId,
  );
  if (!("scope" in authorization)) return authorization;

  const result = await updateRepositoryEnabled(
    repositoryId as RepositoryId,
    isEnabled,
    authorization.scope,
  );
  if (!result.success) {
    return { success: false, error: result.error };
  }
  if (!result.data) return FORBIDDEN;

  revalidatePath("/dashboard/repos");
  return { success: true };
}

export async function saveRepositorySettingsAction(
  repositoryId: string,
  formData: FormData,
): Promise<ActionResult> {
  const authorization = await authorizeRepositoryManagement(
    repositoryId as RepositoryId,
  );
  if (!("scope" in authorization)) return authorization;

  const raw = {
    enabledCategories: formData.getAll("enabledCategories") as string[],
    minimumSeverity: formData.get("minimumSeverity") as string,
    excludePatterns: (formData.getAll("excludePatterns") as string[]).filter(
      Boolean,
    ),
    customInstructions: (formData.get("customInstructions") as string) ?? "",
  };

  const parsed = repositorySettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]?.message ?? "Invalid settings";
    return { success: false, error: firstError };
  }

  const result = await updateRepositorySettings(
    repositoryId as RepositoryId,
    parsed.data,
    authorization.scope,
  );
  if (!result.success) {
    return { success: false, error: result.error };
  }
  if (!result.data) return FORBIDDEN;

  revalidatePath(`/dashboard/repos/${repositoryId}`);
  revalidatePath("/dashboard/repos");
  return { success: true };
}
