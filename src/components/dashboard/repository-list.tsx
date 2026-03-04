import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RepositoryToggle } from "./repository-toggle";

interface Repository {
  readonly id: string;
  readonly fullName: string;
  readonly isEnabled: boolean;
}

interface RepositoryListProps {
  readonly repositories: readonly Repository[];
  readonly installationName: string;
}

export function RepositoryList({
  repositories,
  installationName,
}: RepositoryListProps) {
  if (repositories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No repositories found for {installationName}.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead className="w-[100px] text-center">Reviews</TableHead>
          <TableHead className="w-[100px] text-right">Settings</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {repositories.map((repo) => (
          <TableRow key={repo.id}>
            <TableCell>
              <div className="flex items-center gap-3">
                <RepositoryToggle
                  repositoryId={repo.id}
                  isEnabled={repo.isEnabled}
                />
                <span className="font-medium">{repo.fullName}</span>
              </div>
            </TableCell>
            <TableCell className="text-center">
              <span
                className={
                  repo.isEnabled
                    ? "text-green-600 dark:text-green-400 text-sm"
                    : "text-muted-foreground text-sm"
                }
              >
                {repo.isEnabled ? "Active" : "Paused"}
              </span>
            </TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/dashboard/repos/${repo.id}`}>Configure</Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
