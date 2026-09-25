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

  return ok(validateFindings(parsed, threshold));
}

/**
 * Parses a reply cut off at the output token limit: keeps the findings that
 * were complete before the cut and drops the partial one.
 */
export function parseTruncatedLlmReviewResponse(
  responseText: string,
  confidenceThreshold?: number,
): Result<readonly ReviewFinding[], LLMError> {
  const arrayStart = responseText.indexOf("[");
  if (arrayStart === -1) {
    return err("LLM_INVALID_RESPONSE");
  }

  const repaired = closeAfterCompleteItems(responseText, arrayStart);
  if (repaired === null) {
    return err("LLM_INVALID_RESPONSE");
  }
  return parseLlmReviewResponse(repaired, confidenceThreshold);
}

/**
 * Scans JSON text from the opening "[" and returns the array up to where it
 * closes, or up to its last complete item with "]" appended. Brackets inside
 * strings are ignored. Null when no item is complete.
 */
function closeAfterCompleteItems(
  text: string,
  arrayStart: number,
): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastItemEnd: number | null = null;

  for (let i = arrayStart; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return text.slice(arrayStart, i + 1);
      if (depth === 1) lastItemEnd = i;
    }
  }

  return lastItemEnd === null
    ? null
    : `${text.slice(arrayStart, lastItemEnd + 1)}]`;
}

function validateFindings(
  items: readonly unknown[],
  threshold: number,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (let i = 0; i < items.length; i++) {
    const validated = validateFinding(items[i]);
    if (validated === null) {
      logger.warn("Skipping invalid finding from LLM response", {
        index: i,
        raw: JSON.stringify(items[i]),
      });
      continue;
    }
    if (validated.confidence >= threshold) {
      findings.push(validated);
    }
  }
  return findings;
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

// Line numbers are stored in a Postgres integer column, so a finding with a
// line number outside 1..MAX_LINE_NUMBER would fail the whole review's save.
const MAX_LINE_NUMBER = 2_147_483_647;

function isValidLineNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_LINE_NUMBER
  );
}

// Postgres text columns reject NUL, so one in a finding would fail the whole
// review's save.
const NUL = "\u0000";

function withoutNulCharacters(value: unknown): string | null {
  return typeof value === "string" ? value.replaceAll(NUL, "") : null;
}

function validateFinding(raw: unknown): ReviewFinding | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // A path with a NUL character cannot match a real file.
  const filePath =
    typeof obj.filePath === "string" && !obj.filePath.includes(NUL)
      ? obj.filePath
      : null;
  const lineNumber = isValidLineNumber(obj.lineNumber) ? obj.lineNumber : null;
  const message = withoutNulCharacters(obj.message) || null;
  const suggestion = withoutNulCharacters(obj.suggestion);
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
