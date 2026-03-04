import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface ReviewComment {
  readonly id: string;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly category: string;
  readonly severity: string;
  readonly message: string;
  readonly suggestion: string | null;
  readonly confidence: number;
}

interface ReviewDetailProps {
  readonly summary: string | null;
  readonly issuesFound: number;
  readonly processingTimeMs: number | null;
  readonly comments: readonly ReviewComment[];
}

const SEVERITY_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  CRITICAL: "destructive",
  WARNING: "default",
  SUGGESTION: "secondary",
  NITPICK: "outline",
};

const CATEGORY_LABELS: Record<string, string> = {
  SECURITY: "Security",
  BUGS: "Bug",
  PERFORMANCE: "Performance",
  STYLE: "Style",
  BEST_PRACTICES: "Best Practice",
};

export function ReviewDetail({
  summary,
  issuesFound,
  processingTimeMs,
  comments,
}: ReviewDetailProps) {
  const commentsByFile = groupCommentsByFile(comments);

  return (
    <div className="space-y-6">
      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{summary}</p>
            <div className="flex gap-4 mt-4 text-sm text-muted-foreground">
              <span>{issuesFound} issues found</span>
              {processingTimeMs !== null && (
                <span>
                  Processed in {(processingTimeMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {commentsByFile.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              No inline comments for this review.
            </p>
          </CardContent>
        </Card>
      ) : (
        commentsByFile.map(({ filePath, fileComments }) => (
          <Card key={filePath}>
            <CardHeader>
              <CardTitle className="text-sm font-mono">{filePath}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {fileComments.map((comment, index) => (
                <div key={comment.id}>
                  {index > 0 && <Separator className="mb-4" />}
                  <div className="flex items-center gap-2 mb-2">
                    <Badge
                      variant={SEVERITY_VARIANT[comment.severity] ?? "outline"}
                    >
                      {comment.severity.toLowerCase()}
                    </Badge>
                    <Badge variant="outline">
                      {CATEGORY_LABELS[comment.category] ?? comment.category}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Line {comment.lineNumber}
                    </span>
                  </div>
                  <p className="text-sm">{comment.message}</p>
                  {comment.suggestion && (
                    <pre className="mt-2 rounded-md bg-muted p-3 text-xs overflow-x-auto">
                      <code>{comment.suggestion}</code>
                    </pre>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function groupCommentsByFile(
  comments: readonly ReviewComment[],
): { filePath: string; fileComments: ReviewComment[] }[] {
  const grouped = new Map<string, ReviewComment[]>();

  for (const comment of comments) {
    const existing = grouped.get(comment.filePath);
    if (existing) {
      existing.push(comment);
    } else {
      grouped.set(comment.filePath, [comment]);
    }
  }

  return Array.from(grouped.entries()).map(([filePath, fileComments]) => ({
    filePath,
    fileComments,
  }));
}
