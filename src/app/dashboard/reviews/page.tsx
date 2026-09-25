import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/auth";
import { LoadFailedCard } from "@/components/dashboard/load-failed-card";
import { NoInstallationsCard } from "@/components/dashboard/no-installations-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { ReviewFilters } from "@/components/dashboard/review-filters";
import { ReviewList } from "@/components/dashboard/review-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  type ReviewStatus,
  ReviewStatus as ReviewStatusValues,
} from "@/generated/prisma/enums";
import {
  findInstallationsByGitHubIds,
  listRepositoriesInScope,
  listReviewsInScope,
} from "@/lib/db/queries";
import type { RepositoryId } from "@/types/branded";
import { loadedDataOrLogFailures } from "../loaded-data";
import { isRecordId } from "../record-id";

interface ReviewsPageProps {
  searchParams: Promise<{
    repo?: string;
    status?: string;
    cursor?: string;
  }>;
}

const VALID_STATUSES = new Set<string>(Object.values(ReviewStatusValues));

export default async function ReviewsPage({ searchParams }: ReviewsPageProps) {
  const params = await searchParams;
  const session = await getSession();
  if (!session) {
    redirect("/");
  }

  // The data queries are scoped to the session's access, so starting them
  // before knowing whether there are installations costs nothing extra.
  const [installationsResult, reposResult, reviewsResult] = await Promise.all([
    findInstallationsByGitHubIds(session.access.githubInstallationIds),
    listRepositoriesInScope(session.access),
    listReviewsInScope({
      scope: session.access,
      // A malformed repo or cursor can't match a record; ignore it like an
      // unknown status rather than sending it to the database.
      repositoryId: isRecordId(params.repo)
        ? (params.repo as RepositoryId)
        : undefined,
      status:
        params.status && VALID_STATUSES.has(params.status)
          ? (params.status as ReviewStatus)
          : undefined,
      cursor: isRecordId(params.cursor) ? params.cursor : undefined,
      limit: 20,
    }),
  ]);

  const loaded = loadedDataOrLogFailures("reviews", {
    installations: installationsResult,
    repos: reposResult,
    reviews: reviewsResult,
  });
  if (!loaded) {
    return (
      <div>
        <PageHeader title="Reviews" />
        <LoadFailedCard what="your reviews" />
      </div>
    );
  }
  const { installations, repos, reviews: reviewData } = loaded;

  if (installations.length === 0) {
    return (
      <div>
        <PageHeader title="Reviews" />
        {session.accessPending ? (
          <LoadFailedCard what="your GitHub installations" />
        ) : (
          <NoInstallationsCard />
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Reviews"
        description="Browse code review history across your repositories."
      />

      <ReviewFilters
        repositories={repos.map((r) => ({ id: r.id, fullName: r.fullName }))}
      />

      <Card>
        <CardContent className="pt-6">
          <ReviewList reviews={reviewData.reviews} />

          {reviewData.nextCursor && (
            <div className="flex justify-center pt-4">
              <Button variant="outline" asChild>
                <Link
                  href={`/dashboard/reviews?${new URLSearchParams({
                    ...(params.repo ? { repo: params.repo } : {}),
                    ...(params.status ? { status: params.status } : {}),
                    cursor: reviewData.nextCursor,
                  }).toString()}`}
                >
                  Load more
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
