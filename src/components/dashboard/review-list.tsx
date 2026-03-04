import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ReviewItem {
  readonly id: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly status: string;
  readonly issuesFound: number;
  readonly createdAt: Date;
}

interface ReviewListProps {
  readonly reviews: readonly ReviewItem[];
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

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function ReviewList({ reviews }: ReviewListProps) {
  if (reviews.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No reviews found matching your filters.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead>PR</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Issues</TableHead>
          <TableHead className="text-right">Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reviews.map((review) => (
          <TableRow key={review.id}>
            <TableCell className="font-medium">
              <Link
                href={`/dashboard/reviews/${review.id}`}
                className="hover:underline"
              >
                {review.repositoryFullName}
              </Link>
            </TableCell>
            <TableCell>#{review.pullRequestNumber}</TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[review.status] ?? "outline"}>
                {review.status.toLowerCase()}
              </Badge>
            </TableCell>
            <TableCell className="text-right">{review.issuesFound}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              {formatDate(review.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
