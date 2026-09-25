import { Webhooks } from "@octokit/webhooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries");
vi.mock("@/lib/queue/producer");

import { POST } from "@/app/api/webhooks/github/route";
import { enqueueDeltaReviewJob, enqueueReviewJob } from "@/lib/queue/producer";
import { ok } from "@/types/results";

const signer = new Webhooks({ secret: "test-webhook-secret" });

interface WebhookRequestOptions {
  body: string;
  eventName?: string;
  signature?: string | null;
  deliveryId?: string;
}

async function buildWebhookRequest({
  body,
  eventName = "pull_request",
  signature,
  deliveryId = "delivery-1",
}: WebhookRequestOptions): Promise<Request> {
  const resolvedSignature =
    signature === undefined ? await signer.sign(body) : signature;
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": eventName,
    "x-github-delivery": deliveryId,
  });
  if (resolvedSignature !== null) {
    headers.set("x-hub-signature-256", resolvedSignature);
  }
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers,
    body,
  });
}

function createPullRequestBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    action: "opened",
    pull_request: { number: 42, head: { sha: "abc123" } },
    repository: { full_name: "test-owner/test-repo" },
    installation: { id: 12345 },
    ...overrides,
  });
}

describe("POST /api/webhooks/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enqueueReviewJob).mockResolvedValue(ok({ jobId: "job-1" }));
    vi.mocked(enqueueDeltaReviewJob).mockResolvedValue(
      ok({ jobId: "delta-job-1" }),
    );
  });

  it("returns 400 and enqueues nothing when the signature header is missing", async () => {
    const request = await buildWebhookRequest({
      body: createPullRequestBody(),
      signature: null,
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
    expect(enqueueDeltaReviewJob).not.toHaveBeenCalled();
  });

  it("returns 401 and enqueues nothing when the signature is invalid", async () => {
    const request = await buildWebhookRequest({
      body: createPullRequestBody(),
      signature: `sha256=${"0".repeat(64)}`,
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
    expect(enqueueDeltaReviewJob).not.toHaveBeenCalled();
  });

  it("returns 400 when a validly signed body is not valid JSON", async () => {
    const request = await buildWebhookRequest({ body: "{not json" });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
    expect(enqueueDeltaReviewJob).not.toHaveBeenCalled();
  });

  it("enqueues a review for an 'opened' pull request", async () => {
    const request = await buildWebhookRequest({
      body: createPullRequestBody(),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(enqueueReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestNumber: 42, commitSha: "abc123" }),
    );
  });

  it("enqueues a delta review for a 'synchronize' pull request", async () => {
    const request = await buildWebhookRequest({
      body: createPullRequestBody({ action: "synchronize", before: "prev" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(enqueueDeltaReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ previousCommitSha: "prev" }),
    );
  });

  it("enqueues a review for a 'reopened' pull request", async () => {
    const request = await buildWebhookRequest({
      body: createPullRequestBody({ action: "reopened" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(enqueueReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestNumber: 42 }),
    );
  });

  it.each(["closed", "edited"])(
    "acknowledges a '%s' pull request without enqueuing",
    async (action) => {
      const request = await buildWebhookRequest({
        body: createPullRequestBody({ action }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(enqueueReviewJob).not.toHaveBeenCalled();
      expect(enqueueDeltaReviewJob).not.toHaveBeenCalled();
    },
  );
});
