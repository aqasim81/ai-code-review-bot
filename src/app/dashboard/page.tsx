import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/dashboard/page-header";
import { ReviewStats } from "@/components/dashboard/review-stats";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  findInstallationsByGitHubIds,
  getReviewStatsForInstallation,
  listRepositoriesForInstallation,
} from "@/lib/db/queries";
import { env } from "@/lib/env";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.installationIds) {
    redirect("/");
  }

  const installationsResult = await findInstallationsByGitHubIds(
    session.installationIds,
  );

  if (!installationsResult.success || installationsResult.data.length === 0) {
    return (
      <div>
        <PageHeader
          title="Dashboard"
          description="Welcome to the code review dashboard."
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <h2 className="text-lg font-semibold mb-2">
              No installations found
            </h2>
            <p className="text-muted-foreground mb-4 text-center max-w-md">
              Install the GitHub App on your account or organization to get
              started with automated code reviews.
            </p>
            <Button asChild>
              <a
                href={`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Install on GitHub
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const firstInstallation = installationsResult.data[0];
  if (!firstInstallation) {
    redirect("/");
  }

  const [statsResult, reposResult] = await Promise.all([
    getReviewStatsForInstallation(firstInstallation.id),
    listRepositoriesForInstallation(firstInstallation.id),
  ]);

  const stats = statsResult.success ? statsResult.data : null;
  const repos = reposResult.success ? reposResult.data : [];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`Overview for ${firstInstallation.githubAccountLogin}`}
      />

      {stats && (
        <ReviewStats
          totalReviews={stats.totalReviews}
          totalIssuesFound={stats.totalIssuesFound}
          recentReviewCount={stats.recentReviewCount}
          categoryBreakdown={stats.categoryBreakdown}
        />
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Repositories</CardTitle>
          </CardHeader>
          <CardContent>
            {repos.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repositories found for this installation.
              </p>
            ) : (
              <ul className="space-y-2">
                {repos.slice(0, 5).map((repo) => (
                  <li
                    key={repo.id}
                    className="flex items-center justify-between text-sm"
                  >
                    <Link
                      href={`/dashboard/repos/${repo.id}`}
                      className="hover:underline font-medium"
                    >
                      {repo.fullName}
                    </Link>
                    <span
                      className={
                        repo.isEnabled
                          ? "text-green-600 dark:text-green-400"
                          : "text-muted-foreground"
                      }
                    >
                      {repo.isEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </li>
                ))}
                {repos.length > 5 && (
                  <li className="pt-1">
                    <Link
                      href="/dashboard/repos"
                      className="text-sm text-muted-foreground hover:underline"
                    >
                      View all {repos.length} repositories
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick Links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" className="w-full justify-start" asChild>
              <Link href="/dashboard/repos">Manage Repositories</Link>
            </Button>
            <Button variant="outline" className="w-full justify-start" asChild>
              <Link href="/dashboard/reviews">View Review History</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
