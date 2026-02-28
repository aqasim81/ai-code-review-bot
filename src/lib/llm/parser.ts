import {
  type CommentCategory,
  CommentCategory as CommentCategoryValues,
  type CommentSeverity,
  CommentSeverity as CommentSeverityValues,
} from "@/generated/prisma/enums";
import { logger } from "@/lib/logger";
import type { LLMError } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type { ReviewFinding } from "@/types/review";

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

const VALID_CATEGORIES: ReadonlySet<string> = new Set(
  Object.values(CommentCategoryValues),
);

const VALID_SEVERITIES: ReadonlySet<string> = new Set(
  Object.values(CommentSeverityValues),
);

export function parseLlmReviewResponse(
  responseText: string,
  confidenceThreshold?: number,
): Result<readonly ReviewFinding[], LLMError> {
  const threshold = confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const jsonString = extractJsonFromResponse(responseText);
  if (jsonString === null) {
    return err("LLM_INVALID_RESPONSE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return err("LLM_INVALID_RESPONSE");
  }

  if (!Array.isArray(parsed)) {
    return err("LLM_INVALID_RESPONSE");
  }

  const findings: ReviewFinding[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const validated = validateFinding(parsed[i]);
    if (validated === null) {
      logger.warn("Skipping invalid finding from LLM response", {
        index: i,
        raw: JSON.stringify(parsed[i]),
      });
      continue;
    }
    if (validated.confidence >= threshold) {
      findings.push(validated);
    }
  }

  return ok(findings);
}

function extractJsonFromResponse(text: string): string | null {
  const trimmed = text.trim();

  // Try direct parse first — response might already be valid JSON
  if (trimmed.startsWith("[")) {
    return trimmed;
  }

  // Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1] !== undefined) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("[")) {
      return inner;
    }
  }

  // Find first [ ... ] block in the text
  const bracketStart = trimmed.indexOf("[");
  const bracketEnd = trimmed.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return trimmed.slice(bracketStart, bracketEnd + 1);
  }

  return null;
}

function validateFinding(raw: unknown): ReviewFinding | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  const filePath = typeof obj.filePath === "string" ? obj.filePath : null;
  const lineNumber =
    typeof obj.lineNumber === "number" && Number.isFinite(obj.lineNumber)
      ? obj.lineNumber
      : null;
  const message = typeof obj.message === "string" ? obj.message : null;
  const suggestion = typeof obj.suggestion === "string" ? obj.suggestion : null;
  const confidence =
    typeof obj.confidence === "number" &&
    obj.confidence >= 0 &&
    obj.confidence <= 1
      ? obj.confidence
      : null;

  const category = mapCategoryToEnum(obj.category);
  const severity = mapSeverityToEnum(obj.severity);

  if (
    filePath === null ||
    lineNumber === null ||
    category === null ||
    severity === null ||
    message === null ||
    suggestion === null ||
    confidence === null
  ) {
    return null;
  }

  return {
    filePath,
    lineNumber,
    category,
    severity,
    message,
    suggestion,
    confidence,
  };
}

function mapCategoryToEnum(value: unknown): CommentCategory | null {
  if (typeof value !== "string") {
    return null;
  }
  const upper = value.toUpperCase();
  if (VALID_CATEGORIES.has(upper)) {
    return upper as CommentCategory;
  }
  return null;
}

function mapSeverityToEnum(value: unknown): CommentSeverity | null {
  if (typeof value !== "string") {
    return null;
  }
  const upper = value.toUpperCase();
  if (VALID_SEVERITIES.has(upper)) {
    return upper as CommentSeverity;
  }
  return null;
}
