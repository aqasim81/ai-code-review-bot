import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries");
vi.mock("@/lib/queue/producer");

import {
  createInstallation,
  createRepositories,
  markInstallationDeleted,
} from "@/lib/db/queries";
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handlePullRequestEvent,
} from "@/lib/github/webhook-handler";
import { enqueueDeltaReviewJob, enqueueReviewJob } from "@/lib/queue/producer";
import { err, ok } from "@/types/results";
import { installationId } from "../helpers/factories";

describe("handleInstallationCreated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createPayload(overrides?: Record<string, unknown>) {
    return {
      installation: {
        id: 12345,
        account: { login: "test-user", type: "User" },
        ...((overrides?.installation as Record<string, unknown>) ?? {}),
      },
      sender: { login: "test-sender" },
      repositories: [
        { id: 100, full_name: "test-user/repo-a", node_id: "node1" },
      ],
      ...overrides,
    } as Parameters<typeof handleInstallationCreated>[0];
  }

  it("saves installation and repositories to DB", async () => {
    vi.mocked(createInstallation).mockResolvedValueOnce(
      ok({ id: installationId("inst-1") }),
    );
    vi.mocked(createRepositories).mockResolvedValueOnce(ok({ count: 1 }));

    const result = await handleInstallationCreated(createPayload());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.installationId).toBe("inst-1");
    expect(createInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        githubInstallationId: 12345,
        githubAccountLogin: "test-user",
        githubAccountType: "USER",
      }),
    );
    expect(createRepositories).toHaveBeenCalled();
  });

  it("handles missing account gracefully", async () => {
    const payload = createPayload();
    // Force account to null
    (payload as unknown as Record<string, unknown>).installation = {
      id: 12345,
      account: null,
    };

    const result = await handleInstallationCreated(payload);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("missing account");
  });

  it("returns error when DB save fails", async () => {
    vi.mocked(createInstallation).mockResolvedValueOnce(
      err("DB connection error"),
    );

    const result = await handleInstallationCreated(createPayload());
    expect(result.success).toBe(false);
  });

  it("handles installation with no repositories", async () => {
    vi.mocked(createInstallation).mockResolvedValueOnce(
      ok({ id: installationId("inst-1") }),
    );

    const result = await handleInstallationCreated(
      createPayload({ repositories: [] }),
    );

    expect(result.success).toBe(true);
    expect(createRepositories).not.toHaveBeenCalled();
  });

  it("detects Organization account type", async () => {
    vi.mocked(createInstallation).mockResolvedValueOnce(
      ok({ id: installationId("inst-1") }),
    );

    const payload = createPayload({
      installation: {
        id: 12345,
        account: { login: "test-org", type: "Organization" },
      },
      repositories: [],
    });

    await handleInstallationCreated(payload);

    expect(createInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        githubAccountType: "ORG",
      }),
    );
  });
});

describe("handleInstallationDeleted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks installation as deleted", async () => {
    vi.mocked(markInstallationDeleted).mockResolvedValueOnce(ok(undefined));

    const result = await handleInstallationDeleted({
      installation: {
        id: 12345,
        account: { login: "test-user" },
      },
    });

    expect(result.success).toBe(true);
    expect(markInstallationDeleted).toHaveBeenCalledWith(12345);
  });

  it("returns error when DB update fails", async () => {
    vi.mocked(markInstallationDeleted).mockResolvedValueOnce(err("DB error"));

    const result = await handleInstallationDeleted({
      installation: {
        id: 12345,
        account: { login: "test-user" },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("handlePullRequestEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createPrPayload(overrides?: Record<string, unknown>) {
    return {
      action: "opened",
      pull_request: {
        number: 42,
        head: { sha: "abc123" },
      },
      repository: { full_name: "test-owner/test-repo" },
      installation: { id: 12345 },
      ...overrides,
    };
  }

  it("enqueues review job for 'opened' action", async () => {
    vi.mocked(enqueueReviewJob).mockResolvedValueOnce(ok({ jobId: "job-1" }));

    const result = await handlePullRequestEvent(createPrPayload());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.jobId).toBe("job-1");
    expect(enqueueReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 12345,
        repositoryFullName: "test-owner/test-repo",
        pullRequestNumber: 42,
        commitSha: "abc123",
      }),
    );
  });

  it("enqueues delta review job for 'synchronize' with 'before' sha", async () => {
    vi.mocked(enqueueDeltaReviewJob).mockResolvedValueOnce(
      ok({ jobId: "delta-job-1" }),
    );

    const result = await handlePullRequestEvent(
      createPrPayload({ action: "synchronize", before: "prev-sha" }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.jobId).toBe("delta-job-1");
    expect(enqueueDeltaReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({
        previousCommitSha: "prev-sha",
      }),
    );
  });

  it("ignores non-reviewable actions (closed, edited)", async () => {
    const result = await handlePullRequestEvent(
      createPrPayload({ action: "closed" }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.jobId).toBeUndefined();
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("returns error when installation ID is missing", async () => {
    const result = await handlePullRequestEvent(
      createPrPayload({ installation: undefined }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("Missing installation ID");
  });

  it("returns error when queue enqueue fails", async () => {
    vi.mocked(enqueueReviewJob).mockResolvedValueOnce(
      err("QUEUE_ENQUEUE_FAILED" as const),
    );

    const result = await handlePullRequestEvent(createPrPayload());
    expect(result.success).toBe(false);
  });
});
