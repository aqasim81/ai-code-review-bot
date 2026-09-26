import type { Account, Profile } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the config Auth.js is given, to call its jwt callback directly.
const captured = vi.hoisted(() => ({ config: undefined as unknown }));
vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    captured.config = config;
    return {
      handlers: {},
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
      unstable_update: vi.fn(),
    };
  },
}));
vi.mock("next-auth/providers/github", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@/lib/github/user-access-cache", () => ({
  fetchUserRepositoryAccessShared: vi.fn(),
}));
vi.mock("@/lib/github/user-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/user-token")>()),
  refreshUserTokensShared: vi.fn(),
}));

import "@/auth";
import { fetchUserRepositoryAccessShared } from "@/lib/github/user-access-cache";
import { refreshUserTokensShared } from "@/lib/github/user-token";
import { err, ok } from "@/types/results";

type JwtCallback = (params: {
  token: JWT;
  account?: Account | null;
  profile?: Profile;
  trigger?: "signIn" | "update";
}) => Promise<JWT | null>;

function jwtCallback(): JwtCallback {
  const config = captured.config as { callbacks: { jwt: JwtCallback } };
  return config.callbacks.jwt;
}

const HOUR = 60 * 60_000;
const NOW = 1_700_000_000_000;
const ACCESS = {
  githubInstallationIds: [10],
  accessibleGithubRepoIds: [1],
  manageableGithubRepoIds: [],
  truncated: false,
};

function signedInToken(overrides: Partial<JWT> = {}): JWT {
  return {
    githubId: 1,
    login: "dev",
    accessToken: "ghu_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: NOW + 8 * HOUR,
    access: ACCESS,
    accessFetchedAt: NOW,
    accessCheckedAt: NOW,
    accessPending: false,
    ...overrides,
  };
}

// GitHub App user tokens expire after 8 hours; the session lasts 30 days
// (#130).
describe("jwt callback: the user's GitHub token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW });
    vi.mocked(fetchUserRepositoryAccessShared).mockResolvedValue(
      ok({ access: ACCESS, fetchedAt: NOW }),
    );
  });

  it("keeps the refresh token and expiry GitHub gave at sign-in", async () => {
    const token = await jwtCallback()({
      token: {},
      account: {
        provider: "github",
        type: "oauth",
        providerAccountId: "1",
        access_token: "ghu_first",
        refresh_token: "ghr_first",
        expires_at: Math.floor(NOW / 1000) + 28800,
      },
      profile: { id: "1", login: "dev" } as Profile,
    });

    expect(token).toMatchObject({
      accessToken: "ghu_first",
      refreshToken: "ghr_first",
      accessTokenExpiresAt: NOW + 8 * HOUR,
    });
  });

  it("refreshes an expiring token and uses the new one for GitHub", async () => {
    vi.setSystemTime(NOW + 8 * HOUR - 60_000);
    vi.mocked(refreshUserTokensShared).mockResolvedValue(
      ok({
        accessToken: "ghu_new",
        expiresAt: NOW + 16 * HOUR,
        refreshToken: "ghr_new",
      }),
    );

    const token = await jwtCallback()({
      token: signedInToken({ accessFetchedAt: 0, accessCheckedAt: 0 }),
    });

    expect(token).toMatchObject({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      accessTokenExpiresAt: NOW + 16 * HOUR,
    });
    expect(fetchUserRepositoryAccessShared).toHaveBeenCalledWith(
      "ghu_new",
      expect.anything(),
    );
  });

  it("ends the session when GitHub rejects the refresh token", async () => {
    vi.setSystemTime(NOW + 9 * HOUR);
    vi.mocked(refreshUserTokensShared).mockResolvedValue(
      err({ kind: "token-rejected", message: "bad_refresh_token" }),
    );

    expect(await jwtCallback()({ token: signedInToken() })).toBeNull();
  });

  it("ends the session when GitHub rejects the access token", async () => {
    vi.setSystemTime(NOW + 6 * 60_000);
    vi.mocked(fetchUserRepositoryAccessShared).mockResolvedValue(
      err({ kind: "token-rejected", message: "Bad credentials" }),
    );

    expect(
      await jwtCallback()({
        token: signedInToken({ accessTokenExpiresAt: undefined }),
      }),
    ).toBeNull();
  });

  it("does not use an expired token it could not refresh, and keeps the access pending", async () => {
    vi.setSystemTime(NOW + 9 * HOUR);
    vi.mocked(refreshUserTokensShared).mockResolvedValue(
      err({ kind: "retryable", message: "Bad Gateway" }),
    );

    const token = await jwtCallback()({ token: signedInToken() });

    expect(fetchUserRepositoryAccessShared).not.toHaveBeenCalled();
    expect(token).toMatchObject({ accessPending: true });
  });
});
