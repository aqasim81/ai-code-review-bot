import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import GitHub from "next-auth/providers/github";
import { cache } from "react";
import { env } from "@/lib/env";
import { refreshAccessState } from "@/lib/github/access-refresh";
import { parseUserAccess } from "@/lib/github/repository-access";
import { fetchUserRepositoryAccessShared } from "@/lib/github/user-access-cache";
import {
  keepUserTokenCurrent,
  refreshUserTokensShared,
  type UserTokens,
} from "@/lib/github/user-token";
import { logger } from "@/lib/logger";
import type { UserAccessFetchError } from "@/types/access";
import { err } from "@/types/results";

function timestampOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUserTokens(token: JWT): UserTokens | null {
  if (!token.accessToken) return null;
  return {
    accessToken: token.accessToken,
    expiresAt:
      typeof token.accessTokenExpiresAt === "number"
        ? token.accessTokenExpiresAt
        : null,
    refreshToken: token.refreshToken ?? null,
  };
}

/**
 * Refreshes the user's GitHub token when it is about to expire (#130), and
 * says whether it can be used or the user has to sign in again.
 */
async function keepTokenCurrent(
  token: JWT,
  now: number,
): Promise<"current" | "unavailable" | "sign-in-required"> {
  const tokens = readUserTokens(token);
  if (tokens === null) return "current";
  const kept = await keepUserTokenCurrent({
    tokens,
    now,
    refresh: refreshUserTokensShared,
  });
  if (kept.status === "sign-in-required") {
    logger.info(
      "The user's GitHub token can't be renewed; ending the session",
      {
        login: token.login,
        reason: kept.reason,
      },
    );
    return kept.status;
  }
  if (kept.status === "unavailable" || kept.refreshError) {
    logger.warn("Failed to refresh the user's GitHub token", {
      login: token.login,
      error:
        kept.status === "unavailable"
          ? kept.error.message
          : kept.refreshError?.message,
    });
  }
  if (kept.status === "current") {
    token.accessToken = kept.tokens.accessToken;
    token.accessTokenExpiresAt = kept.tokens.expiresAt ?? undefined;
    token.refreshToken = kept.tokens.refreshToken ?? undefined;
  }
  return kept.status;
}

const TOKEN_UNAVAILABLE: UserAccessFetchError = {
  kind: "retryable",
  message: "The user's GitHub token expired and could not be renewed yet",
};

/**
 * Keeps the token's repository access current: re-fetched every few minutes,
 * or right away when forced (sign-in, or an explicit session update such as
 * after installing the app). Returns false when GitHub rejects the user's
 * token, so they have to sign in again.
 */
async function refreshTokenAccess(
  token: JWT,
  forced: boolean,
  now: number,
  tokenUsable: boolean,
): Promise<boolean> {
  const { state, outcome } = await refreshAccessState({
    state: {
      access: parseUserAccess(token.access),
      fetchedAt: timestampOrZero(token.accessFetchedAt),
      checkedAt: timestampOrZero(token.accessCheckedAt),
      pending: token.accessPending === true,
      ...(typeof token.accessRetryNotBefore === "number" && {
        retryNotBefore: token.accessRetryNotBefore,
      }),
    },
    accessToken: token.accessToken,
    forced,
    now,
    fetchAccess: (accessToken) =>
      tokenUsable
        ? fetchUserRepositoryAccessShared(accessToken, { now, forced })
        : Promise.resolve(err(TOKEN_UNAVAILABLE)),
  });
  if (outcome.kind === "failed") {
    logger.warn("Failed to refresh user repository access", {
      login: token.login,
      kind: outcome.error.kind,
      error: outcome.error.message,
    });
  }
  token.access = state.access;
  token.accessFetchedAt = state.fetchedAt;
  token.accessCheckedAt = state.checkedAt;
  token.accessPending = state.pending;
  token.accessRetryNotBefore = state.retryNotBefore;
  return !(
    outcome.kind === "failed" && outcome.error.kind === "token-rejected"
  );
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
        token.refreshToken = account.refresh_token ?? undefined;
        token.accessTokenExpiresAt =
          typeof account.expires_at === "number"
            ? account.expires_at * 1000
            : undefined;
      }
      const now = Date.now();
      // Returning null ends the session, so the dashboard asks the user to
      // sign in again instead of showing no installations (#130).
      const tokenStatus = await keepTokenCurrent(token, now);
      if (tokenStatus === "sign-in-required") return null;
      const tokenAccepted = await refreshTokenAccess(
        token,
        signingIn || trigger === "update",
        now,
        tokenStatus === "current",
      );
      return tokenAccepted ? token : null;
    },
    async session({ session, token }) {
      session.user.githubId =
        typeof token.githubId === "number" ? token.githubId : 0;
      session.user.login = typeof token.login === "string" ? token.login : "";
      session.user.avatarUrl =
        typeof token.avatarUrl === "string" ? token.avatarUrl : "";
      session.access = parseUserAccess(token.access);
      session.accessPending = token.accessPending === true;
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
