import type { EmitterWebhookEvent } from "@octokit/webhooks";
import {
  createInstallation,
  createRepositories,
  markInstallationDeleted,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { enqueueDeltaReviewJob, enqueueReviewJob } from "@/lib/queue/producer";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

export async function handleInstallationCreated(
  payload: EmitterWebhookEvent<"installation.created">["payload"],
): Promise<Result<{ installationId: string }, string>> {
  const { installation, sender } = payload;
  const account = installation.account;

  if (!account) {
    return err("Installation event missing account data");
  }

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

  const result = await createInstallation({
    githubInstallationId: installation.id,
    githubAccountLogin: accountLogin,
    githubAccountType: accountType,
  });

  if (!result.success) {
    logger.error("Failed to save installation", {
      githubInstallationId: installation.id,
      error: result.error,
    });
    return result;
  }

  logger.info("Installation saved successfully", {
    installationId: result.data.id,
    githubInstallationId: installation.id,
  });

  const repositories = payload.repositories ?? [];

  if (repositories.length > 0) {
    const repoResult = await createRepositories(
      result.data.id,
      repositories.map((repo) => ({
        githubRepoId: repo.id,
        fullName: repo.full_name,
      })),
    );

    if (!repoResult.success) {
      logger.error("Failed to save repositories", {
        installationId: result.data.id,
        error: repoResult.error,
      });
      return err(repoResult.error);
    }

    logger.info("Repositories saved successfully", {
      installationId: result.data.id,
      repositoryCount: repoResult.data.count,
    });
  }

  return ok({ installationId: result.data.id });
}

interface InstallationDeletedPayload {
  installation: {
    id: number;
    account: { login: string; type?: string } | { name: string; slug: string };
  };
}

export async function handleInstallationDeleted(
  payload: InstallationDeletedPayload,
): Promise<Result<{ acknowledged: boolean }, string>> {
  const { installation } = payload;

  logger.info("Processing installation.deleted event", {
    githubInstallationId: installation.id,
  });

  const result = await markInstallationDeleted(installation.id);

  if (!result.success) {
    logger.error("Failed to mark installation as deleted", {
      githubInstallationId: installation.id,
      error: result.error,
    });
    return err(result.error);
  }

  logger.info("Installation marked as deleted", {
    githubInstallationId: installation.id,
  });

  return ok({ acknowledged: true });
}

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

interface PullRequestEventPayload {
  action: string;
  pull_request: {
    number: number;
    head: { sha: string };
  };
  repository: {
    full_name: string;
  };
  installation?: {
    id: number;
  };
  before?: string;
}

export async function handlePullRequestEvent(
  payload: PullRequestEventPayload,
): Promise<Result<{ acknowledged: boolean; jobId?: string }, string>> {
  if (!REVIEWABLE_ACTIONS.has(payload.action)) {
    return ok({ acknowledged: true });
  }

  const installationId = payload.installation?.id;
  if (installationId === undefined) {
    return err("Missing installation ID in webhook payload");
  }

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
      return err(`Failed to enqueue delta review: ${result.error}`);
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
    return err(`Failed to enqueue review: ${result.error}`);
  }

  return ok({ acknowledged: true, jobId: result.data.jobId });
}
