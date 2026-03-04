import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/dashboard/page-header";
import { ReviewDetail } from "@/components/dashboard/review-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  findInstallationsByGitHubIds,
  getReviewWithComments,
} from "@/lib/db/queries";
import type { ReviewId } from "@/types/branded";

interface ReviewDetailPageProps {
  params: Promise<{ id: string }>;
}

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  COMPLETED: "default",
  FAILED: "destructive",
  PROCESSING: "secondary",
  PENDING: "outline",
};

export default async function ReviewDetailPage({
  params,
}: ReviewDetailPageProps) {
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
        <PageHeader title="Review Details" />
        <p className="text-destructive">Failed to load review.</p>
      </div>
    );
  }

  let review = null;
  for (const installation of installationsResult.data) {
    const result = await getReviewWithComments(id as ReviewId, installation.id);
    if (result.success && result.data) {
      review = result.data;
      break;
    }
  }

  if (!review) {
    notFound();
  }

  const [owner, repo] = review.repositoryFullName.split("/");
  const prUrl = `https://github.com/${owner}/${repo}/pull/${review.pullRequestNumber}`;

  return (
    <div>
      <PageHeader
        title={`${review.repositoryFullName} #${review.pullRequestNumber}`}
        description={`Commit ${review.commitSha.slice(0, 7)}`}
      >
        <Badge variant={STATUS_VARIANT[review.status] ?? "outline"}>
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
