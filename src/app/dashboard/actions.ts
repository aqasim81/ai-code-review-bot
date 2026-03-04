"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {
  findInstallationsByGitHubIds,
  findRepositoryByIdForInstallations,
  updateRepositoryEnabled,
  updateRepositorySettings,
} from "@/lib/db/queries";
import type { InstallationId, RepositoryId } from "@/types/branded";
import { repositorySettingsSchema } from "@/types/settings";

async function authorizeRepositoryAccess(
  repositoryId: RepositoryId,
): Promise<InstallationId | null> {
  const session = await auth();
  if (!session?.installationIds?.length) return null;

  const installations = await findInstallationsByGitHubIds(
    session.installationIds,
  );
  if (!installations.success) return null;

  const repo = await findRepositoryByIdForInstallations(
    repositoryId,
    installations.data.map((i) => i.id),
  );
  if (!repo.success || !repo.data) return null;

  return repo.data.installationId;
}

export async function toggleRepositoryEnabledAction(
  repositoryId: string,
  isEnabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  const installationId = await authorizeRepositoryAccess(
    repositoryId as RepositoryId,
  );
  if (!installationId) {
    return { success: false, error: "Unauthorized" };
  }

  const result = await updateRepositoryEnabled(
    repositoryId as RepositoryId,
    isEnabled,
  );
  if (!result.success) {
    return { success: false, error: result.error };
  }

  revalidatePath("/dashboard/repos");
  return { success: true };
}

export async function saveRepositorySettingsAction(
  repositoryId: string,
  formData: FormData,
): Promise<{ success: boolean; error?: string }> {
  const installationId = await authorizeRepositoryAccess(
    repositoryId as RepositoryId,
  );
  if (!installationId) {
    return { success: false, error: "Unauthorized" };
  }

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
  );
  if (!result.success) {
    return { success: false, error: result.error };
  }

  revalidatePath(`/dashboard/repos/${repositoryId}`);
  revalidatePath("/dashboard/repos");
  return { success: true };
}
