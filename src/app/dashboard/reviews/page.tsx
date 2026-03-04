import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
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
  listRepositoriesForInstallation,
  listReviewsForInstallation,
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
        <PageHeader title="Reviews" />
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              No installations found. Install the GitHub App to get started.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const firstInstallation = installationsResult.data[0];
  if (!firstInstallation) {
    redirect("/");
  }

  const [reposResult, reviewsResult] = await Promise.all([
    listRepositoriesForInstallation(firstInstallation.id),
    listReviewsForInstallation({
      installationId: firstInstallation.id,
      repositoryId: params.repo ? (params.repo as RepositoryId) : undefined,
      status:
        params.status && VALID_STATUSES.has(params.status)
          ? (params.status as ReviewStatus)
          : undefined,
      cursor: params.cursor,
      limit: 20,
    }),
  ]);

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
