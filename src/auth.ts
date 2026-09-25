import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { env } from "@/lib/env";
import {
  EMPTY_USER_ACCESS,
  parseUserAccess,
} from "@/lib/github/repository-access";
import { fetchUserRepositoryAccess } from "@/lib/github/user-installations";
import { logger } from "@/lib/logger";

export const { handlers, auth, signIn, signOut } = NextAuth({
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
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.githubId = Number(profile.id);
        token.login = typeof profile.login === "string" ? profile.login : "";
        const profileRecord = profile as Record<string, unknown>;
        token.avatarUrl =
          typeof profileRecord.avatar_url === "string"
            ? profileRecord.avatar_url
            : "";
        token.accessToken = account.access_token ?? undefined;

        if (account.access_token) {
          const result = await fetchUserRepositoryAccess(account.access_token);
          if (result.success) {
            token.access = result.data;
          } else {
            logger.warn("Failed to fetch user repository access at sign-in", {
              error: result.error,
            });
            token.access = EMPTY_USER_ACCESS;
          }
        }
      }
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
