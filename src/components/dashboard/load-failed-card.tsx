import { Card, CardContent } from "@/components/ui/card";

interface LoadFailedCardProps {
  /** What the page could not load, e.g. "your repositories". */
  readonly what: string;
}

/**
 * Shown when a dashboard query fails. A failed query is not an empty answer:
 * telling the user they have no installations, or that a page does not exist,
 * would send them to fix something that is not broken.
 */
export function LoadFailedCard({ what }: LoadFailedCardProps) {
  return (
    <Card>
      <CardContent className="py-8 text-center">
        <p role="alert" className="text-destructive">
          Could not load {what}. Please try again in a moment.
        </p>
      </CardContent>
    </Card>
  );
}
