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

/**
 * A refresh GitHub refused needs a new sign-in; a rate limit lasts until it
 * resets; any other failure may pass on the next request.
 */
export type TokenRefreshError =
  | {
      readonly kind: "retryable" | "token-rejected";
      readonly message: string;
    }
  | {
      readonly kind: "rate-limited";
      readonly message: string;
      /** When GitHub allows the next request (ms epoch). */
      readonly retryAt: number;
    };

type KeptUserTokens =
  | { readonly status: "current"; readonly tokens: UserTokens }
  /** The refresh failed for now; the old token still works. */
  | {
      readonly status: "refresh-failed";
      readonly tokens: UserTokens;
      readonly error: TokenRefreshError;
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
    : { status: "refresh-failed", tokens, error: refreshed.error };
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
  /** A rate-limited answer is reused until GitHub allows a retry. */
  readonly rateLimitedUntil: number | null;
}

function isReusable(entry: SharedRefresh, now: number): boolean {
  return entry.rateLimitedUntil === null
    ? now - entry.startedAt < SHARED_RESULT_MS
    : now < entry.rateLimitedUntil;
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
    if (!isReusable(entry, now)) sharedRefreshes.delete(key);
  }
  // Keys are hashes so live tokens are not kept in memory as map keys.
  const key = createHash("sha256").update(refreshToken).digest("hex");
  const hit = sharedRefreshes.get(key);
  if (hit) return hit.result;

  const entry: SharedRefresh = {
    startedAt: now,
    result: requestTokenRefresh(refreshToken, now),
    rateLimitedUntil: null,
  };
  sharedRefreshes.set(key, entry);
  const settled = await entry.result;
  if (!settled.success && sharedRefreshes.get(key) === entry) {
    if (settled.error.kind === "retryable") sharedRefreshes.delete(key);
    if (settled.error.kind === "rate-limited") {
      sharedRefreshes.set(key, {
        ...entry,
        rateLimitedUntil: settled.error.retryAt,
      });
    }
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

// GitHub asks for at least a minute's wait after a rate limit that names no
// time.
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

function readRetryAt(response: Response, now: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? now + seconds * 1000
    : now + DEFAULT_RATE_LIMIT_WAIT_MS;
}

/**
 * Only GitHub's OAuth error field (bad_refresh_token and the like) says the
 * refresh is refused and the user has to sign in again. A rate limit (429,
 * or 403 as GitHub also reports it) waits for its reset; anything else may
 * pass on a later request.
 */
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
  if (typeof body?.error === "string") {
    return err({
      kind: "token-rejected",
      message: `GitHub refused the token refresh: ${body.error}`,
    });
  }
  const message = `Failed to refresh the GitHub token: HTTP ${response.status}`;
  if (response.status === 429 || response.status === 403) {
    return err({
      kind: "rate-limited",
      message,
      retryAt: readRetryAt(response, now),
    });
  }
  return err({ kind: "retryable", message });
}
