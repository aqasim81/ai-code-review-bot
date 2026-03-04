"use client";

import { useActionState, useState } from "react";
import { saveRepositorySettingsAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const CATEGORIES = [
  { value: "SECURITY", label: "Security" },
  { value: "BUGS", label: "Bugs" },
  { value: "PERFORMANCE", label: "Performance" },
  { value: "STYLE", label: "Style" },
  { value: "BEST_PRACTICES", label: "Best Practices" },
] as const;

const SEVERITIES = [
  { value: "CRITICAL", label: "Critical only" },
  { value: "WARNING", label: "Warning and above" },
  { value: "SUGGESTION", label: "Suggestion and above" },
  { value: "NITPICK", label: "Everything (including nitpicks)" },
] as const;

interface SettingsFormProps {
  readonly repositoryId: string;
  readonly initialSettings: {
    enabledCategories: readonly string[];
    minimumSeverity: string;
    excludePatterns: readonly string[];
    customInstructions: string;
  };
}

export function SettingsForm({
  repositoryId,
  initialSettings,
}: SettingsFormProps) {
  const [nextPatternId, setNextPatternId] = useState(
    initialSettings.excludePatterns.length,
  );
  const [excludePatterns, setExcludePatterns] = useState(
    initialSettings.excludePatterns.map((value, i) => ({
      id: i,
      value,
    })),
  );
  const [minimumSeverity, setMinimumSeverity] = useState(
    initialSettings.minimumSeverity,
  );

  async function handleSubmit(
    _previousState: { success: boolean; error?: string },
    formData: FormData,
  ) {
    formData.set("minimumSeverity", minimumSeverity);
    for (const pattern of excludePatterns) {
      if (pattern.value) {
        formData.append("excludePatterns", pattern.value);
      }
    }
    return await saveRepositorySettingsAction(repositoryId, formData);
  }

  const [state, formAction, isPending] = useActionState(handleSubmit, {
    success: true,
  });

  function addExcludePattern() {
    setNextPatternId((prev) => prev + 1);
    setExcludePatterns((prev) => [...prev, { id: nextPatternId, value: "" }]);
  }

  function removeExcludePattern(id: number) {
    setExcludePatterns((prev) => prev.filter((p) => p.id !== id));
  }

  function updateExcludePattern(id: number, value: string) {
    setExcludePatterns((prev) =>
      prev.map((p) => (p.id === id ? { ...p, value } : p)),
    );
  }

  return (
    <form action={formAction} className="space-y-8">
      <div className="space-y-4">
        <Label className="text-base font-semibold">Review Categories</Label>
        <p className="text-sm text-muted-foreground">
          Select which categories of issues to check for.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {CATEGORIES.map((category) => (
            <div key={category.value} className="flex items-center gap-2">
              <Checkbox
                id={`category-${category.value}`}
                name="enabledCategories"
                value={category.value}
                defaultChecked={initialSettings.enabledCategories.includes(
                  category.value,
                )}
              />
              <Label
                htmlFor={`category-${category.value}`}
                className="font-normal"
              >
                {category.label}
              </Label>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="minimumSeverity" className="text-base font-semibold">
          Minimum Severity
        </Label>
        <p className="text-sm text-muted-foreground">
          Only post comments at or above this severity level.
        </p>
        <Select value={minimumSeverity} onValueChange={setMinimumSeverity}>
          <SelectTrigger id="minimumSeverity" className="w-[280px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEVERITIES.map((severity) => (
              <SelectItem key={severity.value} value={severity.value}>
                {severity.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">File Exclusions</Label>
        <p className="text-sm text-muted-foreground">
          Glob patterns for files to skip during review (e.g., *.lock, dist/**)
        </p>
        <div className="space-y-2">
          {excludePatterns.map((pattern) => (
            <div key={pattern.id} className="flex items-center gap-2">
              <Input
                value={pattern.value}
                onChange={(event) =>
                  updateExcludePattern(pattern.id, event.target.value)
                }
                placeholder="e.g., *.lock"
                className="max-w-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeExcludePattern(pattern.id)}
              >
                Remove
              </Button>
            </div>
          ))}
          {excludePatterns.length < 20 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addExcludePattern}
            >
              Add pattern
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="customInstructions" className="text-base font-semibold">
          Custom Instructions
        </Label>
        <p className="text-sm text-muted-foreground">
          Additional instructions appended to the review prompt (max 2000
          characters).
        </p>
        <Textarea
          id="customInstructions"
          name="customInstructions"
          defaultValue={initialSettings.customInstructions}
          placeholder="e.g., Focus on error handling in async functions..."
          rows={4}
          maxLength={2000}
          className="max-w-lg"
        />
      </div>

      {!state.success && state.error && (
        <p className="text-sm text-destructive">{state.error}</p>
      )}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving..." : "Save Settings"}
      </Button>
    </form>
  );
}
