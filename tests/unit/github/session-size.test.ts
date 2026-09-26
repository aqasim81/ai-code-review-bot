import { encode } from "next-auth/jwt";
import { describe, expect, it } from "vitest";
import { MAX_SESSION_REPOSITORIES } from "@/lib/github/user-installations";

// Proxies commonly reject request headers over 8 KB, and the session cookie
// shares that budget with other cookies.
const SESSION_COOKIE_BUDGET_BYTES = 6144;

describe("session cookie size", () => {
  it("stays within budget at the repository cap with the largest IDs", async () => {
    const repoIds = Array.from(
      { length: MAX_SESSION_REPOSITORIES },
      (_, index) => 9_999_999_999 - index,
    );
    const encoded = await encode({
      secret: "test-secret-with-enough-length-0123456789",
      salt: "authjs.session-token",
      token: {
        sub: "12345678",
        name: "A Reasonably Long Display Name",
        email: "someone@example.com",
        picture: "https://avatars.githubusercontent.com/u/12345678?v=4",
        githubId: 12_345_678,
        login: "a-reasonably-long-login",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345678?v=4",
        accessToken: `ghu_${"x".repeat(36)}`,
        // GitHub App user tokens also carry a refresh token and expiry (#130).
        refreshToken: `ghr_${"x".repeat(76)}`,
        accessTokenExpiresAt: 1_700_000_000_000,
        accessFetchedAt: 1_700_000_000_000,
        accessCheckedAt: 1_700_000_000_000,
        accessPending: true,
        accessRetryNotBefore: 1_700_000_000_000,
        access: {
          githubInstallationIds: [99_999_999, 99_999_998, 99_999_997],
          accessibleGithubRepoIds: repoIds,
          manageableGithubRepoIds: repoIds,
          truncated: true,
        },
      },
    });

    expect(encoded.length).toBeLessThan(SESSION_COOKIE_BUDGET_BYTES);
  });
});
