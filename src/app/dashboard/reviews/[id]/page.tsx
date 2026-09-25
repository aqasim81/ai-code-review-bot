import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/auth";
import { PageHeader } from "@/components/dashboard/page-header";
import { STATUS_VARIANT } from "@/components/dashboard/review-constants";
import { ReviewDetail } from "@/components/dashboard/review-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getReviewWithCommentsInScope } from "@/lib/db/queries";
import type { ReviewId } from "@/types/branded";

interface ReviewDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ReviewDetailPage({
  params,
}: ReviewDetailPageProps) {
  const { id } = await params;
  const session = await getSession();
  if (!session) {
    redirect("/");
  }

  const reviewResult = await getReviewWithCommentsInScope(
    id as ReviewId,
    session.access,
  );

  if (!reviewResult.success || !reviewResult.data) {
    notFound();
  }

  const review = reviewResult.data;

  const prUrl = `https://github.com/${review.repositoryFullName}/pull/${review.pullRequestNumber}`;

  return (
    <div>
      <PageHeader
        title={`${review.repositoryFullName} #${review.pullRequestNumber}`}
        description={`Commit ${review.commitSha.slice(0, 7)}`}
      >
        <Badge variant={STATUS_VARIANT[review.status]}>
          {review.status.toLowerCase()}
        </Badge>
        <Button variant="outline" size="sm" asChild>
          <a href={prUrl} target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/reviews">Back to reviews</Link>
        </Button>
      </PageHeader>

      {review.status === "PENDING" || review.status === "PROCESSING" ? (
        <div className="rounded-md border p-8 text-center">
          <p className="text-muted-foreground">
            This review is currently being processed. Check back shortly.
          </p>
        </div>
      ) : (
        <ReviewDetail
          summary={review.summary}
          issuesFound={review.issuesFound}
          processingTimeMs={review.processingTimeMs}
          comments={review.comments}
        />
      )}
    </div>
  );
}
