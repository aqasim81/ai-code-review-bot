import { z } from "zod";
import {
  createInstallationWithRepositories,
  markInstallationDeleted,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { enqueueDeltaReviewJob, enqueueReviewJob } from "@/lib/queue/producer";
import type { WebhookHandlerError } from "@/types/errors";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

const installationAccountSchema = z.union([
  z.object({ login: z.string().min(1), type: z.string().optional() }),
  z.object({ name: z.string().min(1), slug: z.string() }),
]);

const installationCreatedPayloadSchema = z.object({
  installation: z.object({
    id: z.number().int(),
    account: installationAccountSchema,
  }),
  sender: z.object({ login: z.string() }),
  repositories: z
    .array(z.object({ id: z.number().int(), full_name: z.string().min(1) }))
    .optional(),
});

const installationDeletedPayloadSchema = z.object({
  installation: z.object({ id: z.number().int() }),
});

const pullRequestEventPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string().min(1) }),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
  installation: z.object({ id: z.number().int() }),
  before: z.string().optional(),
});

function parseWebhookPayloadShape<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  eventName: string,
): Result<T, "INVALID_PAYLOAD"> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    logger.warn("Webhook payload failed validation", {
      eventName,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    });
    return err("INVALID_PAYLOAD");
  }
  return ok(parsed.data);
}

export async function handleInstallationCreated(
  payload: unknown,
): Promise<Result<{ installationId: string }, WebhookHandlerError>> {
  const parsed = parseWebhookPayloadShape(
    installationCreatedPayloadSchema,
    payload,
    "installation.created",
  );
  if (!parsed.success) return parsed;
  const { installation, sender } = parsed.data;
  const account = installation.account;

  const accountLogin = "login" in account ? account.login : account.name;
  const accountType =
    "type" in account && account.type === "Organization"
      ? ("ORG" as const)
      : ("USER" as const);

  logger.info("Processing installation.created event", {
    githubInstallationId: installation.id,
    account: accountLogin,
    accountType,
    sender: sender.login,
  });

  const repositories = parsed.data.repositories ?? [];
  const result = await createInstallationWithRepositories(
    {
      githubInstallationId: installation.id,
      githubAccountLogin: accountLogin,
      githubAccountType: accountType,
    },
    repositories.map((repo) => ({
      githubRepoId: repo.id,
      fullName: repo.full_name,
    })),
  );

  if (!result.success) {
    logger.error("Failed to save installation and repositories", {
      githubInstallationId: installation.id,
      error: result.error,
    });
    return err("INSTALLATION_SAVE_FAILED");
  }

  logger.info("Installation saved successfully", {
    installationId: result.data.id,
    githubInstallationId: installation.id,
    repositoryCount: result.data.repositoryCount,
  });

  return ok({ installationId: result.data.id });
}

export async function handleInstallationDeleted(
  payload: unknown,
): Promise<Result<{ acknowledged: boolean }, WebhookHandlerError>> {
  const parsed = parseWebhookPayloadShape(
    installationDeletedPayloadSchema,
    payload,
    "installation.deleted",
  );
  if (!parsed.success) return parsed;
  const { installation } = parsed.data;

  logger.info("Processing installation.deleted event", {
    githubInstallationId: installation.id,
  });

  const result = await markInstallationDeleted(installation.id);

  if (!result.success) {
    logger.error("Failed to mark installation as deleted", {
      githubInstallationId: installation.id,
      error: result.error,
    });
    return err("INSTALLATION_DELETE_FAILED");
  }

  logger.info("Installation marked as deleted", {
    githubInstallationId: installation.id,
  });

  return ok({ acknowledged: true });
}

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export async function handlePullRequestEvent(
  rawPayload: unknown,
): Promise<
  Result<{ acknowledged: boolean; jobId?: string }, WebhookHandlerError>
> {
  const parsed = parseWebhookPayloadShape(
    pullRequestEventPayloadSchema,
    rawPayload,
    "pull_request",
  );
  if (!parsed.success) return parsed;
  const payload = parsed.data;

  if (!REVIEWABLE_ACTIONS.has(payload.action)) {
    return ok({ acknowledged: true });
  }
  const installationId = payload.installation.id;

  logger.info("Processing pull_request event", {
    action: payload.action,
    prNumber: payload.pull_request.number,
    repo: payload.repository.full_name,
    installationId,
    commitSha: payload.pull_request.head.sha,
  });

  if (payload.action === "synchronize" && payload.before) {
    const result = await enqueueDeltaReviewJob({
      installationId,
      repositoryFullName: payload.repository.full_name,
      pullRequestNumber: payload.pull_request.number,
      commitSha: payload.pull_request.head.sha,
      previousCommitSha: payload.before,
    });

    if (!result.success) {
      logger.error("Failed to enqueue delta review job", {
        error: result.error,
        repository: payload.repository.full_name,
      });
      return err("REVIEW_ENQUEUE_FAILED");
    }

    return ok({ acknowledged: true, jobId: result.data.jobId });
  }

  const result = await enqueueReviewJob({
    installationId,
    repositoryFullName: payload.repository.full_name,
    pullRequestNumber: payload.pull_request.number,
    commitSha: payload.pull_request.head.sha,
  });

  if (!result.success) {
    logger.error("Failed to enqueue review job", {
      error: result.error,
      repository: payload.repository.full_name,
    });
    return err("REVIEW_ENQUEUE_FAILED");
  }

  return ok({ acknowledged: true, jobId: result.data.jobId });
}
