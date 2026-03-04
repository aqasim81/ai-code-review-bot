import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      githubId: number;
      login: string;
      avatarUrl: string;
    };
    installationIds: number[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    githubId?: number;
    login?: string;
    avatarUrl?: string;
    accessToken?: string;
    installationIds?: number[];
  }
}
