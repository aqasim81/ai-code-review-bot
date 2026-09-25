import { CATEGORY_LABELS } from "@/components/dashboard/review-constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CommentCategory } from "@/generated/prisma/enums";

interface ReviewStatsProps {
  readonly totalReviews: number;
  readonly totalIssuesFound: number;
  readonly recentReviewCount: number;
  readonly categoryBreakdown: ReadonlyArray<{
    category: CommentCategory;
    count: number;
  }>;
}

function StatCard({
  title,
  value,
  detail,
}: {
  readonly title: string;
  readonly value: string | number;
  readonly detail?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

export function ReviewStats({
  totalReviews,
  totalIssuesFound,
  recentReviewCount,
  categoryBreakdown,
}: ReviewStatsProps) {
  const topCategory =
    categoryBreakdown.length > 0
      ? [...categoryBreakdown].sort((a, b) => b.count - a.count)[0]
      : null;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard title="Total Reviews" value={totalReviews} />
      <StatCard title="Issues Found" value={totalIssuesFound} />
      <StatCard title="Last 30 Days" value={recentReviewCount} />
      <StatCard
        title="Top Category"
        value={topCategory ? CATEGORY_LABELS[topCategory.category] : "N/A"}
        detail={topCategory ? `${topCategory.count} issues` : undefined}
      />
    </div>
  );
}
