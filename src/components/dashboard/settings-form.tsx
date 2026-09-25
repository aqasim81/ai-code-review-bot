"use client";

import { useActionState, useRef, useState } from "react";
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

// null until the form is first submitted.
type SaveState = Awaited<
  ReturnType<typeof saveRepositorySettingsAction>
> | null;

interface SettingsFormProps {
  readonly repositoryId: string;
  readonly canManage: boolean;
  readonly initialSettings: {
    enabledCategories: readonly string[];
    minimumSeverity: string;
    excludePatterns: readonly string[];
    customInstructions: string;
  };
}

export function SettingsForm({
  repositoryId,
  canManage,
  initialSettings,
}: SettingsFormProps) {
  const nextPatternIdRef = useRef(initialSettings.excludePatterns.length);
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
    _previousState: SaveState,
    formData: FormData,
  ): Promise<SaveState> {
    formData.set("minimumSeverity", minimumSeverity);
    for (const pattern of excludePatterns) {
      if (pattern.value) {
        formData.append("excludePatterns", pattern.value);
      }
    }
    return await saveRepositorySettingsAction(repositoryId, formData);
  }

  const [state, formAction, isPending] = useActionState<SaveState, FormData>(
    handleSubmit,
    null,
  );

  function addExcludePattern() {
    const id = nextPatternIdRef.current;
    nextPatternIdRef.current += 1;
    setExcludePatterns((prev) => [...prev, { id, value: "" }]);
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
    <form action={formAction}>
      {!canManage && (
        <p className="mb-6 text-sm text-muted-foreground">
          You can view these settings. Changing them requires admin or maintain
          permission on the repository.
        </p>
      )}
      <fieldset disabled={!canManage} className="space-y-8">
        <fieldset className="space-y-4">
          <legend className="text-base font-semibold">Review Categories</legend>
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
        </fieldset>

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

        <fieldset className="space-y-3">
          <legend className="text-base font-semibold">File Exclusions</legend>
          <p className="text-sm text-muted-foreground">
            Glob patterns for files to skip during review (e.g., *.lock,
            dist/**)
          </p>
          <div className="space-y-2">
            {excludePatterns.map((pattern, index) => (
              <div key={pattern.id} className="flex items-center gap-2">
                <Input
                  aria-label={`Exclude pattern ${index + 1}`}
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
                  aria-label={`Remove exclude pattern ${index + 1}`}
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
        </fieldset>

        <div className="space-y-2">
          <Label
            htmlFor="customInstructions"
            className="text-base font-semibold"
          >
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

        {/* Both regions stay mounted and are emptied while saving, so each
            result is a change that assistive technology announces. */}
        <p role="alert" className="text-sm text-destructive empty:hidden">
          {!isPending && state && !state.success ? state.error : ""}
        </p>
        <output className="block text-sm text-muted-foreground empty:hidden">
          {!isPending && state?.success ? "Settings saved." : ""}
        </output>

        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : "Save Settings"}
        </Button>
      </fieldset>
    </form>
  );
}
