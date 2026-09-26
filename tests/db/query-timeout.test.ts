import { describe, expect, it } from "vitest";
import { testPrisma } from "./database";

// GitHub times a webhook delivery out after 10 s; a query that hangs on the
// server has to be cancelled before that (#137).
const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

describe("a query that runs too long (#137)", () => {
  it("is cancelled well before GitHub's webhook timeout", async () => {
    const startedAt = Date.now();

    await expect(testPrisma.$queryRaw`SELECT pg_sleep(30)`).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(WEBHOOK_DELIVERY_TIMEOUT_MS);
  }, 40_000);

  it("leaves the pool usable afterwards", async () => {
    await expect(testPrisma.$queryRaw`SELECT pg_sleep(30)`).rejects.toThrow();

    await expect(testPrisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([
      { ok: 1 },
    ]);
  }, 40_000);
});
