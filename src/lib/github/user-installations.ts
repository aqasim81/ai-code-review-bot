import { Octokit } from "@octokit/rest";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";

const INSTALLATIONS_PER_PAGE = 100;

export async function fetchUserInstallationIds(
  accessToken: string,
): Promise<Result<readonly number[], string>> {
  try {
    const octokit = new Octokit({ auth: accessToken });
    const installations = await octokit.paginate(
      octokit.apps.listInstallationsForAuthenticatedUser,
      { per_page: INSTALLATIONS_PER_PAGE },
    );
    return ok(installations.map((installation) => installation.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to fetch user installations: ${message}`);
  }
}
