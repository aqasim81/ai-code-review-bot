import { notFound, redirect } from "next/navigation";
import { getSession } from "@/auth";
import { LoadFailedCard } from "@/components/dashboard/load-failed-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { SettingsForm } from "@/components/dashboard/settings-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { findAccessibleRepositoryById } from "@/lib/db/queries";
import { canManageRepository } from "@/lib/github/repository-access";
import type { RepositoryId } from "@/types/branded";
import { mergeWithDefaults } from "@/types/settings";
import { loadedDataOrLogFailures } from "../../loaded-data";
import { isRecordId } from "../../record-id";

interface RepoSettingsPageProps {
  params: Promise<{ id: string }>;
}

export default async function RepoSettingsPage({
  params,
}: RepoSettingsPageProps) {
  const { id } = await params;
  const session = await getSession();
  if (!session) {
    redirect("/");
  }

  // A malformed id can't match a record: answer 404 without a query.
  if (!isRecordId(id)) {
    notFound();
  }

  const repoResult = await findAccessibleRepositoryById(
    id as RepositoryId,
    session.access,
  );

  const loaded = loadedDataOrLogFailures("repository settings", {
    repo: repoResult,
  });
  if (!loaded) {
    return (
      <div>
        <PageHeader title="Repository" />
        <LoadFailedCard what="this repository" />
      </div>
    );
  }

  const { repo } = loaded;
  // Outside access that is still loading may be inside it once it loads.
  if (!repo && session.accessPending) {
    return (
      <div>
        <PageHeader title="Repository" />
        <LoadFailedCard what="this repository" />
      </div>
    );
  }
  if (!repo) {
    notFound();
  }

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
            canManage={canManageRepository(session.access, repo.githubRepoId)}
            initialSettings={settings}
          />
        </CardContent>
      </Card>
    </div>
  );
}
