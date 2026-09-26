import "next-auth";
import "next-auth/jwt";
import type { UserAccess } from "@/types/access";

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
    access: UserAccess;
    /** Loading the access the user asked for failed and is being retried. */
    accessPending: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    githubId?: number;
    login?: string;
    avatarUrl?: string;
    accessToken?: string;
    access?: UserAccess;
    accessFetchedAt?: number;
    accessCheckedAt?: number;
    accessPending?: boolean;
    /** GitHub rate-limited the user's token until then (ms epoch). */
    accessRetryNotBefore?: number;
  }
}
