"use client";

import { useTransition } from "react";
import { toggleRepositoryEnabledAction } from "@/app/dashboard/actions";
import { Switch } from "@/components/ui/switch";

interface RepositoryToggleProps {
  readonly repositoryId: string;
  readonly isEnabled: boolean;
}

export function RepositoryToggle({
  repositoryId,
  isEnabled,
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
      disabled={isPending}
      aria-label={isEnabled ? "Disable reviews" : "Enable reviews"}
    />
  );
}
