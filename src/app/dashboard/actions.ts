"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/auth";
import {
  findAccessibleRepositoryById,
  updateRepositoryEnabled,
  updateRepositorySettings,
} from "@/lib/db/queries";
import { canManageRepository } from "@/lib/github/repository-access";
import { logger } from "@/lib/logger";
import type { AccessScope } from "@/types/access";
import type { RepositoryId } from "@/types/branded";
import { repositorySettingsSchema } from "@/types/settings";
import { isRecordId } from "./record-id";

type ActionResult = { success: true } | { success: false; error: string };

// Server actions are callable with any serialisable arguments, not only the
// ones the UI sends, so check their shape before using them in a query.
const isEnabledSchema = z.boolean();

const UNAUTHORIZED: ActionResult = { success: false, error: "Unauthorized" };
// Database errors carry internal detail; log it and show the user this.
const SAVE_FAILED: ActionResult = {
  success: false,
  error: "Could not save the change. Please try again.",
};

const FORBIDDEN: ActionResult = {
  success: false,
  error: "You need admin or maintain permission on this repository.",
};

// While the user's access is loading, a repository missing from it or not yet
// manageable in it may be allowed once it loads (#141).
const ACCESS_PENDING: ActionResult = {
  success: false,
  error: "Your GitHub access is still loading. Please try again in a moment.",
};

interface RepositoryAuthorization {
  readonly scope: AccessScope;
  /** The answer when the scoped write matches no repository. */
  readonly refusal: ActionResult;
}

/**
 * Returns the caller's access scope when they can manage the repository. A
 * repository outside their scope is reported as unauthorized, so the answer
 * does not reveal that it exists, unless their access is still loading.
 */
async function authorizeRepositoryManagement(
  repositoryId: RepositoryId,
): Promise<RepositoryAuthorization | ActionResult> {
  const session = await auth();
  if (!session) return UNAUTHORIZED;

  const repo = await findAccessibleRepositoryById(repositoryId, session.access);
  // A failed lookup says nothing about access: report a save the user can
  // retry, not a refusal.
  if (!repo.success) {
    logger.error("Failed to look up repository for a change", {
      repositoryId,
      error: repo.error,
    });
    return SAVE_FAILED;
  }
  if (session.accessPending) {
    if (!repo.data) return ACCESS_PENDING;
    if (!canManageRepository(session.access, repo.data.githubRepoId)) {
      return ACCESS_PENDING;
    }
    return { scope: session.access, refusal: ACCESS_PENDING };
  }
  if (!repo.data) return UNAUTHORIZED;
  if (!canManageRepository(session.access, repo.data.githubRepoId)) {
    return FORBIDDEN;
  }
  return { scope: session.access, refusal: FORBIDDEN };
}

export async function toggleRepositoryEnabledAction(
  repositoryId: string,
  isEnabled: boolean,
): Promise<ActionResult> {
  if (
    !isRecordId(repositoryId) ||
    !isEnabledSchema.safeParse(isEnabled).success
  ) {
    return UNAUTHORIZED;
  }
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
    logger.error("Failed to update repository", {
      repositoryId,
      error: result.error,
    });
    return SAVE_FAILED;
  }
  if (!result.data) return authorization.refusal;

  revalidatePath("/dashboard/repos");
  return { success: true };
}

export async function saveRepositorySettingsAction(
  repositoryId: string,
  formData: FormData,
): Promise<ActionResult> {
  if (!isRecordId(repositoryId) || !(formData instanceof FormData)) {
    return UNAUTHORIZED;
  }
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
    logger.error("Failed to save repository settings", {
      repositoryId,
      error: result.error,
    });
    return SAVE_FAILED;
  }
  if (!result.data) return authorization.refusal;

  revalidatePath(`/dashboard/repos/${repositoryId}`);
  revalidatePath("/dashboard/repos");
  return { success: true };
}
