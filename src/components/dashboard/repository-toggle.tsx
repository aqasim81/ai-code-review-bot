"use client";

import { useState, useTransition } from "react";
import { toggleRepositoryEnabledAction } from "@/app/dashboard/actions";
import { Switch } from "@/components/ui/switch";

interface RepositoryToggleProps {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly isEnabled: boolean;
  readonly canManage: boolean;
}

export function RepositoryToggle({
  repositoryId,
  repositoryName,
  isEnabled,
  canManage,
}: RepositoryToggleProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleToggle(checked: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await toggleRepositoryEnabledAction(repositoryId, checked);
      if (!result.success) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Switch
        checked={isEnabled}
        onCheckedChange={handleToggle}
        disabled={isPending || !canManage}
        aria-label={`Reviews for ${repositoryName}`}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
