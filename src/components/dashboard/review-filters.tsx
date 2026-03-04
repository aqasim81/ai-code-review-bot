"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Repository {
  readonly id: string;
  readonly fullName: string;
}

interface ReviewFiltersProps {
  readonly repositories: readonly Repository[];
}

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "COMPLETED", label: "Completed" },
  { value: "FAILED", label: "Failed" },
  { value: "PROCESSING", label: "Processing" },
  { value: "PENDING", label: "Pending" },
] as const;

export function ReviewFilters({ repositories }: ReviewFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentRepo = searchParams.get("repo") ?? "all";
  const currentStatus = searchParams.get("status") ?? "all";

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    params.delete("cursor");
    router.push(`/dashboard/reviews?${params.toString()}`);
  }

  return (
    <div className="flex gap-3 pb-4">
      <Select
        value={currentRepo}
        onValueChange={(value) => updateFilter("repo", value)}
      >
        <SelectTrigger className="w-[240px]">
          <SelectValue placeholder="All repositories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All repositories</SelectItem>
          {repositories.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={currentStatus}
        onValueChange={(value) => updateFilter("status", value)}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
