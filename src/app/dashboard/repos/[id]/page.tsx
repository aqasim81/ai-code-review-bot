import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/dashboard/page-header";
import { SettingsForm } from "@/components/dashboard/settings-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  findInstallationsByGitHubIds,
  findRepositoryByIdForInstallations,
} from "@/lib/db/queries";
import type { RepositoryId } from "@/types/branded";
import { mergeWithDefaults } from "@/types/settings";

interface RepoSettingsPageProps {
  params: Promise<{ id: string }>;
}

export default async function RepoSettingsPage({
  params,
}: RepoSettingsPageProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.installationIds) {
    redirect("/");
  }

  const installationsResult = await findInstallationsByGitHubIds(
    session.installationIds,
  );

  if (!installationsResult.success) {
    return (
      <div>
        <PageHeader title="Repository Settings" />
        <p className="text-destructive">Failed to load installations.</p>
      </div>
    );
  }

  const repoResult = await findRepositoryByIdForInstallations(
    id as RepositoryId,
    installationsResult.data.map((i) => i.id),
  );

  if (!repoResult.success || !repoResult.data) {
    notFound();
  }

  const repo = repoResult.data;

  const settings = mergeWithDefaults(repo.settings);

  return (
    <div>
      <PageHeader
        title={repo.fullName}
        description="Configure code review settings for this repository."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsForm
            repositoryId={repo.id}
            initialSettings={{
              enabledCategories: settings.enabledCategories,
              minimumSeverity: settings.minimumSeverity,
              excludePatterns: settings.excludePatterns,
              customInstructions: settings.customInstructions,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
