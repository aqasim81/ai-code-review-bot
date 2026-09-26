import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// pg waits without limit by default: for a connection (a TCP connect, or a
// free client when the pool is exhausted) and for a query's answer (#137).
// GitHub times a webhook delivery out after 10 s, so one database call from
// the webhook route has to give up well before that: at most 3 s to get a
// connection, then 5 s for Postgres to run the statement, with the client's
// own read timeout as the backstop for a server that stops answering.
const CONNECTION_TIMEOUT_MS = 3_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const QUERY_READ_TIMEOUT_MS = 6_000;

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(
    {
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: QUERY_READ_TIMEOUT_MS,
    },
    {
      onPoolError: (error) => {
        logger.error("Postgres pool error", { error: error.message });
      },
    },
  );
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
