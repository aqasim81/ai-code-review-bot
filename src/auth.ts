import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { fetchUserInstallations } from "@/lib/github/user-installations";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.githubId = Number(profile.id);
        token.login = profile.login as string;
        token.avatarUrl = (profile as Record<string, unknown>)
          .avatar_url as string;
        token.accessToken = account.access_token ?? undefined;

        if (account.access_token) {
          const result = await fetchUserInstallations(account.access_token);
          if (result.success) {
            token.installationIds = result.data.map(
              (installation) => installation.id,
            );
          } else {
            token.installationIds = [];
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.githubId = (token.githubId as number) ?? 0;
      session.user.login = (token.login as string) ?? "";
      session.user.avatarUrl = (token.avatarUrl as string) ?? "";
      session.installationIds = (token.installationIds as number[]) ?? [];
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
});
