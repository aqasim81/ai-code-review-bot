import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenRefreshError, UserTokens } from "@/lib/github/user-token";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

// GitHub App user tokens expire after 8 hours; the refresh token lasts 6
// months and works once ("Once you use a refresh token, that refresh token and
// the old user access token will no longer work"), per GitHub's docs on
// refreshing user access tokens (#130).
const HOUR = 60 * 60_000;
const NOW = 1_700_000_000_000;
const TOKENS: UserTokens = {
  accessToken: "ghu_old",
  expiresAt: NOW + 8 * HOUR,
  refreshToken: "ghr_old",
};
const REFRESHED: UserTokens = {
  accessToken: "ghu_new",
  expiresAt: NOW + 8 * HOUR,
  refreshToken: "ghr_new",
};

async function loadFresh() {
  vi.resetModules();
  return import("@/lib/github/user-token");
}

type Refresh = (
  refreshToken: string,
  now: number,
) => Promise<Result<UserTokens, TokenRefreshError>>;

describe("keepUserTokenCurrent (#130)", () => {
  const refreshingTo = (result: Result<UserTokens, TokenRefreshError>) =>
    vi.fn<Refresh>().mockResolvedValue(result);

  it.each([
    ["never expires", { ...TOKENS, expiresAt: null }, NOW],
    ["expires in hours", TOKENS, NOW + HOUR],
  ])("leaves a token that %s alone", async (_label, tokens, now) => {
    const { keepUserTokenCurrent } = await loadFresh();
    const refresh = refreshingTo(ok(REFRESHED));

    const kept = await keepUserTokenCurrent({ tokens, now, refresh });

    expect(kept).toEqual({ status: "current", tokens });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["about to expire", NOW + 8 * HOUR - 60_000],
    ["already expired", NOW + 9 * HOUR],
  ])("refreshes a token %s", async (_label, now) => {
    const { keepUserTokenCurrent } = await loadFresh();
    const refresh = refreshingTo(ok(REFRESHED));

    const kept = await keepUserTokenCurrent({ tokens: TOKENS, now, refresh });

    expect(kept).toEqual({ status: "current", tokens: REFRESHED });
    expect(refresh).toHaveBeenCalledWith("ghr_old", now);
  });

  it("asks the user to sign in again when GitHub rejects the refresh token", async () => {
    const { keepUserTokenCurrent } = await loadFresh();
    const refresh = refreshingTo(
      err({ kind: "token-rejected", message: "bad_refresh_token" }),
    );

    const kept = await keepUserTokenCurrent({
      tokens: TOKENS,
      now: NOW + 9 * HOUR,
      refresh,
    });

    expect(kept.status).toBe("sign-in-required");
  });

  it("asks the user to sign in again when an expired token has no refresh token", async () => {
    const { keepUserTokenCurrent } = await loadFresh();

    const kept = await keepUserTokenCurrent({
      tokens: { ...TOKENS, refreshToken: null },
      now: NOW + 9 * HOUR,
      refresh: refreshingTo(ok(REFRESHED)),
    });

    expect(kept.status).toBe("sign-in-required");
  });

  it("keeps a token that is still valid when a refresh fails for now", async () => {
    const { keepUserTokenCurrent } = await loadFresh();
    const failure = { kind: "retryable", message: "Bad Gateway" } as const;

    const kept = await keepUserTokenCurrent({
      tokens: TOKENS,
      now: NOW + 8 * HOUR - 60_000,
      refresh: refreshingTo(err(failure)),
    });

    expect(kept).toEqual({
      status: "current",
      tokens: TOKENS,
      refreshError: failure,
    });
  });

  it("reports an expired token it could not refresh for now as unavailable", async () => {
    const { keepUserTokenCurrent } = await loadFresh();
    const failure = { kind: "retryable", message: "Bad Gateway" } as const;

    const kept = await keepUserTokenCurrent({
      tokens: TOKENS,
      now: NOW + 9 * HOUR,
      refresh: refreshingTo(err(failure)),
    });

    expect(kept).toEqual({ status: "unavailable", error: failure });
  });
});

describe("refreshUserTokensShared (#130)", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const GRANTED = {
    access_token: "ghu_new",
    expires_in: 28800,
    refresh_token: "ghr_new",
    refresh_token_expires_in: 15897600,
    token_type: "bearer",
    scope: "",
  };

  it("exchanges the refresh token at GitHub and stamps the expiry", async () => {
    fetchMock.mockResolvedValue(jsonResponse(GRANTED));
    const { refreshUserTokensShared } = await loadFresh();

    const result = await refreshUserTokensShared("ghr_old", NOW);

    expect(result).toEqual(ok(REFRESHED));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a refresh token once, however many requests carry it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(GRANTED));
    const { refreshUserTokensShared } = await loadFresh();

    const results = await Promise.all([
      refreshUserTokensShared("ghr_old", NOW),
      refreshUserTokensShared("ghr_old", NOW),
    ]);
    // A request that still carries the old cookie a minute later.
    const late = await refreshUserTokensShared("ghr_old", NOW + 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...results, late]).toEqual([
      ok(REFRESHED),
      ok(REFRESHED),
      ok(REFRESHED),
    ]);
  });

  it("reports a refused refresh token as rejected", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      }),
    );
    const { refreshUserTokensShared } = await loadFresh();

    const result = await refreshUserTokensShared("ghr_old", NOW);

    expect(result).toEqual({
      success: false,
      error: {
        kind: "token-rejected",
        message: expect.stringContaining("bad_refresh_token"),
      },
    });
  });

  it.each([
    [
      "a server error",
      () => Promise.resolve(new Response("oops", { status: 502 })),
    ],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
  ])(
    "reports %s as retryable and asks again next time",
    async (_label, fail) => {
      fetchMock
        .mockImplementationOnce(fail)
        .mockResolvedValueOnce(jsonResponse(GRANTED));
      const { refreshUserTokensShared } = await loadFresh();

      const first = await refreshUserTokensShared("ghr_old", NOW);
      const second = await refreshUserTokensShared("ghr_old", NOW + 1_000);

      expect(first).toMatchObject({
        success: false,
        error: { kind: "retryable" },
      });
      expect(second).toEqual(
        ok({ ...REFRESHED, expiresAt: NOW + 1_000 + 8 * HOUR }),
      );
    },
  );

  it("returns a token that never expires when GitHub sends no expiry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: "ghu_new", token_type: "bearer" }),
    );
    const { refreshUserTokensShared } = await loadFresh();

    expect(await refreshUserTokensShared("ghr_old", NOW)).toEqual(
      ok({ accessToken: "ghu_new", expiresAt: null, refreshToken: null }),
    );
  });
});
