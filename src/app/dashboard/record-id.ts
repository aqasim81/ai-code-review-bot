import { z } from "zod";

const recordIdSchema = z.string().uuid();

/**
 * Record ids are UUIDs. A value from a URL or a server action argument that
 * isn't one can never match a record, and may hold characters Postgres rejects
 * in text (NUL), so check it before it reaches a query.
 */
export function isRecordId(value: unknown): value is string {
  return recordIdSchema.safeParse(value).success;
}
