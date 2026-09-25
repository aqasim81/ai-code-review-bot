import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A port that accepts connections and closes them at once, so the real
// ioredis client under the producer never becomes ready: Valkey is down.
const unreachable = vi.hoisted(() => ({ port: 0 }));

vi.mock("@/lib/queue/connection", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/queue/connection")>();
  return {
    ...original,
    createValkeyConnectionOptions: () => ({
      ...original.createValkeyConnectionOptions(),
      host: "127.0.0.1",
      port: unreachable.port,
    }),
  };
});

import { enqueueReviewJob } from "@/lib/queue/producer";

// GitHub gives up on a webhook delivery that has not been answered in 10 s.
const GITHUB_DELIVERY_TIMEOUT_MS = 10_000;

let closedServer: Server;

beforeAll(async () => {
  closedServer = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => {
    closedServer.listen(0, "127.0.0.1", resolve);
  });
  const address = closedServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no port");
  }
  unreachable.port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => closedServer.close(() => resolve()));
});

describe("enqueueing a review while Valkey is down", () => {
  it(
    "fails with QUEUE_ENQUEUE_FAILED before GitHub times out the delivery",
    async () => {
      const startedAt = Date.now();
      const outcome = await Promise.race([
        enqueueReviewJob({
          installationId: 1,
          githubRepoId: 2,
          repositoryFullName: "octo-org/repo",
          pullRequestNumber: 7,
          commitSha: "abc123",
        }),
        new Promise<"still pending">((resolve) => {
          setTimeout(
            () => resolve("still pending"),
            GITHUB_DELIVERY_TIMEOUT_MS,
          );
        }),
      ]);

      expect(outcome).toEqual({
        success: false,
        error: "QUEUE_ENQUEUE_FAILED",
      });
      expect(Date.now() - startedAt).toBeLessThan(GITHUB_DELIVERY_TIMEOUT_MS);
    },
    GITHUB_DELIVERY_TIMEOUT_MS + 5_000,
  );
});
