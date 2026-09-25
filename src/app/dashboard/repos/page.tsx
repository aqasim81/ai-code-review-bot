import { redirect } from "next/navigation";
import { getSession } from "@/auth";
import { NoInstallationsCard } from "@/components/dashboard/no-installations-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { RepositoryList } from "@/components/dashboard/repository-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  findInstallationsByGitHubIds,
  listRepositoriesInScope,
} from "@/lib/db/queries";
import { canManageRepository } from "@/lib/github/repository-access";

export default async function RepositoriesPage() {
  const session = await getSession();
  if (!session) {
    redirect("/");
  }

  const [installationsResult, reposResult] = await Promise.all([
    findInstallationsByGitHubIds(session.access.githubInstallationIds),
    listRepositoriesInScope(session.access),
  ]);

  if (!installationsResult.success) {
    return (
      <div>
        <PageHeader title="Repositories" />
        <p className="text-destructive">Failed to load installations.</p>
      </div>
    );
  }

  const repositories = reposResult.success ? reposResult.data : [];
  const installationsWithRepos = installationsResult.data.map(
    (installation) => ({
      installation,
      repositories: repositories
        .filter((repo) => repo.installationId === installation.id)
        .map((repo) => ({
          ...repo,
          canManage: canManageRepository(session.access, repo.githubRepoId),
        })),
    }),
  );

  return (
    <div>
      <PageHeader
        title="Repositories"
        description="Manage which repositories receive automated code reviews."
      />

      {installationsWithRepos.length === 0 ? (
        <NoInstallationsCard />
      ) : (
        <div className="space-y-6">
          {installationsWithRepos.map(({ installation, repositories }) => (
            <Card key={installation.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  {installation.githubAccountLogin}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RepositoryList
                  repositories={repositories}
                  installationName={installation.githubAccountLogin}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
