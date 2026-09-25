import { describe, expect, it } from "vitest";
import {
  createExcludedPathMatcher,
  filterFindingsBySettings,
} from "@/lib/review/settings-filter";
import { mergeWithDefaults } from "@/types/settings";
import { createReviewFinding } from "../../helpers/factories";

describe("createExcludedPathMatcher", () => {
  it("excludes nothing when there are no patterns", () => {
    const isExcluded = createExcludedPathMatcher([]);

    expect(isExcluded("src/a.ts")).toBe(false);
  });

  it("matches a pattern without a slash against the file name in any directory", () => {
    const isExcluded = createExcludedPathMatcher(["*.lock"]);

    expect(isExcluded("yarn.lock")).toBe(true);
    expect(isExcluded("packages/web/Cargo.lock")).toBe(true);
    expect(isExcluded("src/lock.ts")).toBe(false);
  });

  it("matches a pattern with a slash from the repository root", () => {
    const isExcluded = createExcludedPathMatcher(["dist/**"]);

    expect(isExcluded("dist/bundle.js")).toBe(true);
    expect(isExcluded("dist/nested/chunk.js")).toBe(true);
    expect(isExcluded("packages/dist/bundle.js")).toBe(false);
  });

  it("matches dotfiles and dot directories", () => {
    const isExcluded = createExcludedPathMatcher([".github/**", "*.yml"]);

    expect(isExcluded(".github/workflows/ci.ts")).toBe(true);
    expect(isExcluded("config/.prettierrc.yml")).toBe(true);
  });

  it("treats a leading ! literally instead of inverting the pattern", () => {
    const isExcluded = createExcludedPathMatcher(["!*.md"]);

    expect(isExcluded("src/a.ts")).toBe(false);
    expect(isExcluded("README.md")).toBe(false);
  });

  it("ignores blank patterns", () => {
    const isExcluded = createExcludedPathMatcher(["", "   "]);

    expect(isExcluded("src/a.ts")).toBe(false);
  });
});

describe("filterFindingsBySettings", () => {
  const ALL_SEVERITIES = [
    createReviewFinding({ severity: "CRITICAL" }),
    createReviewFinding({ severity: "WARNING" }),
    createReviewFinding({ severity: "SUGGESTION" }),
    createReviewFinding({ severity: "NITPICK" }),
  ];

  function severitiesKept(minimumSeverity: string): string[] {
    const settings = mergeWithDefaults({ minimumSeverity });
    return filterFindingsBySettings(ALL_SEVERITIES, settings).map(
      (finding) => finding.severity,
    );
  }

  it("keeps findings at or above the minimum severity", () => {
    expect(severitiesKept("NITPICK")).toEqual([
      "CRITICAL",
      "WARNING",
      "SUGGESTION",
      "NITPICK",
    ]);
    expect(severitiesKept("SUGGESTION")).toEqual([
      "CRITICAL",
      "WARNING",
      "SUGGESTION",
    ]);
    expect(severitiesKept("CRITICAL")).toEqual(["CRITICAL"]);
  });

  it("drops findings in a disabled category", () => {
    const settings = mergeWithDefaults({
      enabledCategories: ["SECURITY"],
      minimumSeverity: "NITPICK",
    });
    const findings = [
      createReviewFinding({ category: "SECURITY" }),
      createReviewFinding({ category: "STYLE" }),
    ];

    expect(
      filterFindingsBySettings(findings, settings).map((f) => f.category),
    ).toEqual(["SECURITY"]);
  });
});
