import type { ConnectionOptions } from "bullmq";
import { env } from "@/lib/env";

export function createValkeyConnectionOptions(): ConnectionOptions {
  const url = new URL(env.VALKEY_URL);

  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}
