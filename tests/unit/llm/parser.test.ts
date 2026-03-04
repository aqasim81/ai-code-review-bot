import { describe, expect, it } from "vitest";
import { parseLlmReviewResponse } from "@/lib/llm/parser";
import {
  EMPTY_ARRAY,
  INVALID_CATEGORY,
  INVALID_JSON,
  INVALID_SEVERITY,
  MISSING_FIELDS,
  MIXED_CONFIDENCE,
  NO_JSON_CONTENT,
  NON_ARRAY_JSON,
  OUT_OF_RANGE_CONFIDENCE,
  VALID_JSON_ARRAY,
  VALID_MARKDOWN_FENCED,
  VALID_WITH_PREAMBLE,
} from "../../fixtures/llm-responses";

describe("parseLlmReviewResponse", () => {
  // --- Valid responses ---

  it("parses valid JSON array response", () => {
    const result = parseLlmReviewResponse(VALID_JSON_ARRAY);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.filePath).toBe("src/lib/auth.ts");
    expect(result.data[0]?.category).toBe("SECURITY");
    expect(result.data[0]?.severity).toBe("CRITICAL");
    expect(result.data[1]?.category).toBe("BUGS");
  });

  it("extracts JSON from markdown code fences", () => {
    const result = parseLlmReviewResponse(VALID_MARKDOWN_FENCED);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.category).toBe("PERFORMANCE");
  });

  it("extracts JSON from response with preamble text", () => {
    const result = parseLlmReviewResponse(VALID_WITH_PREAMBLE);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.category).toBe("BEST_PRACTICES");
  });

  it("returns empty array for '[]' response", () => {
    const result = parseLlmReviewResponse(EMPTY_ARRAY);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(0);
  });

  // --- Invalid responses ---

  it("returns LLM_INVALID_RESPONSE for malformed JSON", () => {
    const result = parseLlmReviewResponse(INVALID_JSON);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_INVALID_RESPONSE");
  });

  it("returns LLM_INVALID_RESPONSE for non-array JSON", () => {
    const result = parseLlmReviewResponse(NON_ARRAY_JSON);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_INVALID_RESPONSE");
  });

  it("returns LLM_INVALID_RESPONSE for no JSON content", () => {
    const result = parseLlmReviewResponse(NO_JSON_CONTENT);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_INVALID_RESPONSE");
  });

  // --- Confidence filtering ---

  it("filters findings below default confidence threshold (0.7)", () => {
    const result = parseLlmReviewResponse(MIXED_CONFIDENCE);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 0.95 and 0.7 pass, 0.3 filtered
    expect(result.data).toHaveLength(2);
    const filePaths = result.data.map((f) => f.filePath);
    expect(filePaths).toContain("src/lib/high.ts");
    expect(filePaths).toContain("src/lib/threshold.ts");
    expect(filePaths).not.toContain("src/lib/low.ts");
  });

  it("filters findings below custom confidence threshold", () => {
    const result = parseLlmReviewResponse(MIXED_CONFIDENCE, 0.9);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Only 0.95 passes at threshold 0.9
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.filePath).toBe("src/lib/high.ts");
  });

  it("includes findings at exactly the threshold", () => {
    const result = parseLlmReviewResponse(MIXED_CONFIDENCE, 0.7);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const thresholdFinding = result.data.find(
      (f) => f.filePath === "src/lib/threshold.ts",
    );
    expect(thresholdFinding).toBeDefined();
    expect(thresholdFinding?.confidence).toBe(0.7);
  });

  // --- Validation ---

  it("skips findings with missing required fields", () => {
    const result = parseLlmReviewResponse(MISSING_FIELDS);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Only the first finding with all fields should pass
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.filePath).toBe("src/lib/good.ts");
  });

  it("skips findings with invalid category values", () => {
    const result = parseLlmReviewResponse(INVALID_CATEGORY);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(0);
  });

  it("skips findings with invalid severity values", () => {
    const result = parseLlmReviewResponse(INVALID_SEVERITY);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(0);
  });

  it("maps lowercase category strings to uppercase enums", () => {
    const result = parseLlmReviewResponse(VALID_JSON_ARRAY);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Input has lowercase "security", "bugs" — output should be uppercase
    expect(result.data[0]?.category).toBe("SECURITY");
    expect(result.data[1]?.category).toBe("BUGS");
  });

  it("maps lowercase severity strings to uppercase enums", () => {
    const result = parseLlmReviewResponse(VALID_JSON_ARRAY);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data[0]?.severity).toBe("CRITICAL");
    expect(result.data[1]?.severity).toBe("WARNING");
  });

  it("skips findings with confidence outside 0-1 range", () => {
    const result = parseLlmReviewResponse(OUT_OF_RANGE_CONFIDENCE);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(0);
  });

  it("returns valid findings alongside invalid ones (partial success)", () => {
    const result = parseLlmReviewResponse(MISSING_FIELDS);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 1 valid + 2 invalid = 1 returned
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.message).toBe("Valid finding");
  });
});
