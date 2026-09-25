import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/auth";
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
      repositoryId: params.repo ? (params.repo as RepositoryId) : undefined,
      status:
        params.status && VALID_STATUSES.has(params.status)
          ? (params.status as ReviewStatus)
          : undefined,
      cursor: params.cursor,
      limit: 20,
    }),
  ]);

  if (!installationsResult.success || installationsResult.data.length === 0) {
    return (
      <div>
        <PageHeader title="Reviews" />
        <NoInstallationsCard />
      </div>
    );
  }

  const repos = reposResult.success ? reposResult.data : [];
  const reviewData = reviewsResult.success
    ? reviewsResult.data
    : { reviews: [], nextCursor: null };

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
