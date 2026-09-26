import { describe, expect, it } from "vitest";
import {
  parseLlmReviewResponse,
  parseTruncatedLlmReviewResponse,
} from "@/lib/llm/parser";
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

  it("skips findings whose line number is not a positive 32-bit integer", () => {
    const finding = (lineNumber: number) => ({
      filePath: "src/a.ts",
      lineNumber,
      category: "bugs",
      severity: "warning",
      message: "Problem",
      suggestion: "Fix it",
      confidence: 0.9,
    });
    const response = JSON.stringify([
      finding(0),
      finding(-3),
      finding(12.5),
      finding(3_000_000_000),
      finding(7),
    ]);

    const result = parseLlmReviewResponse(response);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((item) => item.lineNumber)).toEqual([7]);
  });

  it("removes NUL characters from text and drops findings with a NUL path or no message left", () => {
    const finding = (filePath: string, message: string) => ({
      filePath,
      lineNumber: 3,
      category: "bugs",
      severity: "warning",
      message,
      suggestion: "Use\u0000 a guard",
      confidence: 0.9,
    });
    const response = JSON.stringify([
      finding("src/a.ts", "Null\u0000byte in message"),
      finding("src/b\u0000.ts", "Path is not a real file"),
      finding("src/c.ts", "\u0000\u0000"),
    ]);

    const result = parseLlmReviewResponse(response);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.message).toBe("Nullbyte in message");
    expect(result.data[0]?.suggestion).toBe("Use a guard");
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

describe("parseTruncatedLlmReviewResponse", () => {
  const complete = (message: string) =>
    JSON.stringify({
      filePath: "src/a.ts",
      lineNumber: 3,
      category: "BUGS",
      severity: "WARNING",
      message,
      suggestion: "Fix it.",
      confidence: 0.9,
    });

  it("keeps the complete findings before the cut and drops the partial one", () => {
    const text = `\`\`\`json\n[${complete('Braces } ] and a "quote" inside')}, ${complete("second")}, {"filePath": "src/b.ts", "message": "cut of`;

    const result = parseTruncatedLlmReviewResponse(text);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((finding) => finding.message)).toEqual([
      'Braces } ] and a "quote" inside',
      "second",
    ]);
  });

  it("parses a reply whose array is complete", () => {
    const result = parseTruncatedLlmReviewResponse(`[${complete("only")}]`);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
  });

  it("applies the confidence threshold to recovered findings", () => {
    const result = parseTruncatedLlmReviewResponse(
      `[${complete("kept")}, {"filePath": "src/b.ts"`,
      0.95,
    );

    expect(result).toEqual({ success: true, data: [] });
  });

  // The limit cut the reply before anything could be kept (#120).
  it.each([
    ["no complete finding", '[{"filePath": "src/a.ts", "message": "cut'],
    ["no array", "I could not review this because"],
    ["no text", ""],
  ])("returns LLM_OUTPUT_LIMIT_REACHED when there is %s", (_label, text) => {
    expect(parseTruncatedLlmReviewResponse(text)).toEqual({
      success: false,
      error: "LLM_OUTPUT_LIMIT_REACHED",
    });
  });

  // Bad output the limit did not cause stays bad output, so a retry can help (#120).
  it.each([
    [
      "an array that closed before the cut but is not JSON",
      'Reviewing [src/a.ts] now: [{"filePath": "src/a.ts", "message": "cut',
    ],
    [
      "a complete item that is not JSON",
      `[{"filePath": src/a.ts}, ${complete("second")}, {"filePath": "src/b.ts"`,
    ],
  ])("returns LLM_INVALID_RESPONSE for %s", (_label, text) => {
    expect(parseTruncatedLlmReviewResponse(text)).toEqual({
      success: false,
      error: "LLM_INVALID_RESPONSE",
    });
  });
});
