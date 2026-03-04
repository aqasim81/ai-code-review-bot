import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ReviewStatsProps {
  readonly totalReviews: number;
  readonly totalIssuesFound: number;
  readonly recentReviewCount: number;
  readonly categoryBreakdown: ReadonlyArray<{
    category: string;
    count: number;
  }>;
}

const CATEGORY_LABELS: Record<string, string> = {
  SECURITY: "Security",
  BUGS: "Bugs",
  PERFORMANCE: "Performance",
  STYLE: "Style",
  BEST_PRACTICES: "Best Practices",
};

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
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Total Reviews
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalReviews}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Issues Found
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalIssuesFound}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Last 30 Days
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{recentReviewCount}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Top Category
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {topCategory
              ? (CATEGORY_LABELS[topCategory.category] ?? topCategory.category)
              : "N/A"}
          </div>
          {topCategory && (
            <p className="text-xs text-muted-foreground">
              {topCategory.count} issues
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
