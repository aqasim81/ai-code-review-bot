import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

/**
 * The user's GitHub token for the dashboard. GitHub App user tokens expire
 * after 8 hours and come with a refresh token that lasts 6 months, unless the
 * app opted out of expiry (GitHub's docs on refreshing user access tokens).
 */
export interface UserTokens {
  readonly accessToken: string;
  /** When the access token expires (ms epoch); null when it never does. */
  readonly expiresAt: number | null;
  readonly refreshToken: string | null;
}

/** A refresh GitHub refused needs a new sign-in; any other may pass later. */
export interface TokenRefreshError {
  readonly kind: "retryable" | "token-rejected";
  readonly message: string;
}

export type KeptUserTokens =
  | {
      readonly status: "current";
      readonly tokens: UserTokens;
      /** A refresh that failed while the old token still works. */
      readonly refreshError?: TokenRefreshError;
    }
  | { readonly status: "unavailable"; readonly error: TokenRefreshError }
  | { readonly status: "sign-in-required"; readonly reason: string };

// Refreshed this long before it expires, so no request is sent with a token
// that expires on the way.
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Refreshes the user's token when it expires within a few minutes. A refused
 * refresh, or an expired token with nothing to refresh it with, needs a new
 * sign-in; an expired token whose refresh failed for now can't be used until
 * a later request refreshes it (#130).
 */
export async function keepUserTokenCurrent(input: {
  readonly tokens: UserTokens;
  readonly now: number;
  readonly refresh: (
    refreshToken: string,
    now: number,
  ) => Promise<Result<UserTokens, TokenRefreshError>>;
}): Promise<KeptUserTokens> {
  const { tokens, now, refresh } = input;
  if (tokens.expiresAt === null || now < tokens.expiresAt - REFRESH_MARGIN_MS) {
    return { status: "current", tokens };
  }
  const expired = now >= tokens.expiresAt;
  if (tokens.refreshToken === null) {
    return expired
      ? { status: "sign-in-required", reason: "The GitHub token expired" }
      : { status: "current", tokens };
  }

  const refreshed = await refresh(tokens.refreshToken, now);
  if (refreshed.success) return { status: "current", tokens: refreshed.data };
  if (refreshed.error.kind === "token-rejected") {
    return { status: "sign-in-required", reason: refreshed.error.message };
  }
  return expired
    ? { status: "unavailable", error: refreshed.error }
    : { status: "current", tokens, refreshError: refreshed.error };
}

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
// A refresh token works once, and every request carrying the old session
// cookie tries it (middleware, layout and page, and requests in parallel), so
// the first answer is shared with them for a while.
const SHARED_RESULT_MS = 10 * 60_000;

interface SharedRefresh {
  readonly startedAt: number;
  readonly result: Promise<Result<UserTokens, TokenRefreshError>>;
}

const sharedRefreshes = new Map<string, SharedRefresh>();

/**
 * Exchanges a refresh token for new tokens, once per refresh token: callers
 * with the same one share the answer. A failure a retry can fix is shared only
 * while in flight.
 */
export async function refreshUserTokensShared(
  refreshToken: string,
  now: number,
): Promise<Result<UserTokens, TokenRefreshError>> {
  for (const [key, entry] of sharedRefreshes) {
    if (now - entry.startedAt >= SHARED_RESULT_MS) sharedRefreshes.delete(key);
  }
  // Keys are hashes so live tokens are not kept in memory as map keys.
  const key = createHash("sha256").update(refreshToken).digest("hex");
  const hit = sharedRefreshes.get(key);
  if (hit) return hit.result;

  const entry = {
    startedAt: now,
    result: requestTokenRefresh(refreshToken, now),
  };
  sharedRefreshes.set(key, entry);
  const settled = await entry.result;
  if (!settled.success && settled.error.kind === "retryable") {
    if (sharedRefreshes.get(key) === entry) sharedRefreshes.delete(key);
  }
  return settled;
}

async function requestTokenRefresh(
  refreshToken: string,
  now: number,
): Promise<Result<UserTokens, TokenRefreshError>> {
  try {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    return readTokenResponse(response, await readJsonObject(response), now);
  } catch (error) {
    return err({
      kind: "retryable",
      message: `Failed to refresh the GitHub token: ${describeError(error)}`,
    });
  }
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readTokenResponse(
  response: Response,
  body: Record<string, unknown> | null,
  now: number,
): Result<UserTokens, TokenRefreshError> {
  if (typeof body?.access_token === "string") {
    return ok({
      accessToken: body.access_token,
      expiresAt:
        typeof body.expires_in === "number"
          ? now + body.expires_in * 1000
          : null,
      refreshToken:
        typeof body.refresh_token === "string" ? body.refresh_token : null,
    });
  }
  // GitHub answers a refused refresh (bad_refresh_token and the like) with an
  // error field; a server error or a rate limit may pass later.
  const retryable =
    body?.error === undefined &&
    (response.status >= 500 || response.status === 429);
  return err({
    kind: retryable ? "retryable" : "token-rejected",
    message: `GitHub refused the token refresh: ${
      typeof body?.error === "string" ? body.error : `HTTP ${response.status}`
    }`,
  });
}
