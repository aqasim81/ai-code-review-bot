/** The message of a caught value, for logs and error strings. */
export function describeError(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
