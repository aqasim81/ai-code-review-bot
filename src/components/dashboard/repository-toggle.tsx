"use client";

import { useTransition } from "react";
import { toggleRepositoryEnabledAction } from "@/app/dashboard/actions";
import { Switch } from "@/components/ui/switch";

interface RepositoryToggleProps {
  readonly repositoryId: string;
  readonly isEnabled: boolean;
  readonly canManage: boolean;
}

export function RepositoryToggle({
  repositoryId,
  isEnabled,
  canManage,
}: RepositoryToggleProps) {
  const [isPending, startTransition] = useTransition();

  function handleToggle(checked: boolean) {
    startTransition(async () => {
      await toggleRepositoryEnabledAction(repositoryId, checked);
    });
  }

  return (
    <Switch
      checked={isEnabled}
      onCheckedChange={handleToggle}
      disabled={isPending || !canManage}
      aria-label={isEnabled ? "Disable reviews" : "Enable reviews"}
    />
  );
}
