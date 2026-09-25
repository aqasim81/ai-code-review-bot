export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `baseMs` for the first attempt, multiplied by `multiplier` for each after. */
export function exponentialDelayMs(
  baseMs: number,
  multiplier: number,
  attempt: number,
): number {
  return baseMs * multiplier ** (attempt - 1);
}
