import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A Postgres that accepts the TCP connection and never answers, like a hung
// server or a host behind a firewall that drops packets (#137).
const silentServer = vi.hoisted(() => ({ port: 0 }));
const openSockets: Socket[] = [];
let server: Server;

vi.mock("@/lib/env", () => ({
  env: {
    get DATABASE_URL() {
      return `postgresql://postgres:postgres@127.0.0.1:${silentServer.port}/silent_test`;
    },
    NODE_ENV: "production",
  },
}));

beforeAll(async () => {
  server = createServer((socket) => {
    openSockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent server has no port");
  }
  silentServer.port = address.port;
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// GitHub times a webhook delivery out after 10 s; a database call has to
// give up well before that.
const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

async function secondsUntilSettled(query: Promise<unknown>): Promise<number> {
  const startedAt = Date.now();
  await query.then(
    () => {
      throw new Error("the query must not succeed");
    },
    () => undefined,
  );
  return Date.now() - startedAt;
}

describe("Prisma client against a database that never answers (#137)", () => {
  it(
    "fails a query well before GitHub's webhook timeout",
    async () => {
      const { prisma } = await import("@/lib/db/prisma-client");

      const elapsedMs = await secondsUntilSettled(prisma.$queryRaw`SELECT 1`);

      expect(elapsedMs).toBeLessThan(WEBHOOK_DELIVERY_TIMEOUT_MS / 2);
    },
    WEBHOOK_DELIVERY_TIMEOUT_MS * 2,
  );

  it(
    "fails a query waiting for a connection when every one is stuck",
    async () => {
      const { prisma } = await import("@/lib/db/prisma-client");

      // More queries than the pool has connections: the rest wait in its queue.
      const elapsed = await Promise.all(
        Array.from({ length: 15 }, () =>
          secondsUntilSettled(prisma.$queryRaw`SELECT 1`),
        ),
      );

      expect(Math.max(...elapsed)).toBeLessThan(WEBHOOK_DELIVERY_TIMEOUT_MS);
    },
    WEBHOOK_DELIVERY_TIMEOUT_MS * 3,
  );
});
