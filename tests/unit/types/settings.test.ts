import { describe, expect, it } from "vitest";
import { mergeWithDefaults } from "@/types/settings";

const DEFAULTS = {
  enabledCategories: [
    "SECURITY",
    "BUGS",
    "PERFORMANCE",
    "STYLE",
    "BEST_PRACTICES",
  ],
  minimumSeverity: "SUGGESTION",
  excludePatterns: [],
  customInstructions: "",
};

describe("mergeWithDefaults", () => {
  it("returns the defaults for a missing or non-object value", () => {
    expect(mergeWithDefaults(null)).toEqual(DEFAULTS);
    expect(mergeWithDefaults("settings")).toEqual(DEFAULTS);
    expect(mergeWithDefaults({})).toEqual(DEFAULTS);
  });

  it("keeps valid stored values", () => {
    const stored = {
      enabledCategories: ["BUGS"],
      minimumSeverity: "CRITICAL",
      excludePatterns: ["dist/**"],
      customInstructions: "We use tabs.",
    };

    expect(mergeWithDefaults(stored)).toEqual(stored);
  });

  it("falls back per field when a stored value is invalid", () => {
    const merged = mergeWithDefaults({
      enabledCategories: "BUGS",
      minimumSeverity: "BLOCKER",
      excludePatterns: "dist/**",
      customInstructions: "bad\u0000text",
    });

    expect(merged).toEqual(DEFAULTS);
  });

  it("drops unknown categories and keeps the known ones", () => {
    const merged = mergeWithDefaults({
      enabledCategories: ["SECURITY", "OLD_CATEGORY"],
    });

    expect(merged.enabledCategories).toEqual(["SECURITY"]);
  });

  it("falls back to every category when no known one is enabled", () => {
    expect(mergeWithDefaults({ enabledCategories: ["OLD_CATEGORY"] })).toEqual(
      DEFAULTS,
    );
  });

  it("falls back to every category when none is enabled", () => {
    expect(mergeWithDefaults({ enabledCategories: [] })).toEqual(DEFAULTS);
  });

  it("keeps valid fields next to invalid ones", () => {
    const merged = mergeWithDefaults({
      minimumSeverity: "WARNING",
      excludePatterns: [42],
    });

    expect(merged.minimumSeverity).toBe("WARNING");
    expect(merged.excludePatterns).toEqual([]);
  });
});
