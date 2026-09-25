import { Card, CardContent } from "@/components/ui/card";

export function NoInstallationsCard() {
  return (
    <Card>
      <CardContent className="py-8 text-center">
        <p className="text-muted-foreground">
          No installations found. Install the GitHub App to get started.
        </p>
      </CardContent>
    </Card>
  );
}
