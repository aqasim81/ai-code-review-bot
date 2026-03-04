import { Octokit } from "@octokit/rest";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

interface UserInstallation {
  readonly id: number;
  readonly account: {
    readonly login: string;
    readonly type: string;
  };
}

export async function fetchUserInstallations(
  accessToken: string,
): Promise<Result<readonly UserInstallation[], string>> {
  try {
    const octokit = new Octokit({ auth: accessToken });
    const response = await octokit.apps.listInstallationsForAuthenticatedUser();

    const installations = response.data.installations.map((installation) => {
      const account = installation.account;
      const login =
        account && "login" in account
          ? (account.login as string)
          : (account?.name ?? "");
      const type =
        account && "type" in account
          ? (account.type as string)
          : "Organization";

      return {
        id: installation.id,
        account: { login, type },
      };
    });

    return ok(installations);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to fetch user installations: ${message}`);
  }
}
