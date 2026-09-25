import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import GitHub from "next-auth/providers/github";
import { cache } from "react";
import { env } from "@/lib/env";
import { refreshAccessState } from "@/lib/github/access-refresh";
import { parseUserAccess } from "@/lib/github/repository-access";
import { fetchUserRepositoryAccessShared } from "@/lib/github/user-access-cache";
import { logger } from "@/lib/logger";

function timestampOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Keeps the token's repository access current: re-fetched every few minutes,
 * or right away when forced (sign-in, or an explicit session update such as
 * after installing the app).
 */
async function refreshTokenAccess(token: JWT, forced: boolean): Promise<void> {
  const now = Date.now();
  const { state, outcome } = await refreshAccessState({
    state: {
      access: parseUserAccess(token.access),
      fetchedAt: timestampOrZero(token.accessFetchedAt),
      checkedAt: timestampOrZero(token.accessCheckedAt),
    },
    accessToken: token.accessToken,
    forced,
    now,
    fetchAccess: (accessToken) =>
      fetchUserRepositoryAccessShared(accessToken, { now, forced }),
  });
  if (outcome.kind === "failed") {
    logger.warn("Failed to refresh user repository access", {
      login: token.login,
      error: outcome.error,
    });
  }
  token.access = state.access;
  token.accessFetchedAt = state.fetchedAt;
  token.accessCheckedAt = state.checkedAt;
}

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  providers: [
    GitHub({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }),
  ],
  secret: env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
  },
  callbacks: {
    // Never copy the `session` argument into the token: clients can send it.
    async jwt({ token, account, profile, trigger }) {
      const signingIn = Boolean(account && profile);
      if (account && profile) {
        token.githubId = Number(profile.id);
        token.login = typeof profile.login === "string" ? profile.login : "";
        const profileRecord = profile as Record<string, unknown>;
        token.avatarUrl =
          typeof profileRecord.avatar_url === "string"
            ? profileRecord.avatar_url
            : "";
        token.accessToken = account.access_token ?? undefined;
      }
      await refreshTokenAccess(token, signingIn || trigger === "update");
      return token;
    },
    async session({ session, token }) {
      session.user.githubId =
        typeof token.githubId === "number" ? token.githubId : 0;
      session.user.login = typeof token.login === "string" ? token.login : "";
      session.user.avatarUrl =
        typeof token.avatarUrl === "string" ? token.avatarUrl : "";
      session.access = parseUserAccess(token.access);
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
});

/**
 * The session for the current server render, read once per request so the
 * dashboard layout and page share it. Server actions call `auth` directly.
 */
export const getSession = cache(() => auth());
