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

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

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

  const items = extractFindingsArray(responseText);
  if (items === null) {
    return err("LLM_INVALID_RESPONSE");
  }
  return ok(validateFindings(items, threshold));
}

/**
 * Parses a reply cut off at the output token limit: keeps the findings that
 * were complete before the cut and drops the partial one. A cut before any
 * item was complete is LLM_OUTPUT_LIMIT_REACHED; a closed or repaired array
 * that is not valid JSON is still LLM_INVALID_RESPONSE.
 */
export function parseTruncatedLlmReviewResponse(
  responseText: string,
  confidenceThreshold?: number,
): Result<readonly ReviewFinding[], LLMError> {
  const repaired = findingsArrayStarts(responseText).flatMap((arrayStart) => {
    const text = closeAfterCompleteItems(responseText, arrayStart);
    return text === null ? [] : [text];
  });
  const items = pickFindingsArray(repaired.map(parseJsonArray));
  if (items !== null) {
    return ok(
      validateFindings(
        items,
        confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      ),
    );
  }
  if (repaired.length > 0) return err("LLM_INVALID_RESPONSE");

  // No finding was complete; the reply may still hold a whole empty array.
  const whole = parseLlmReviewResponse(responseText, confidenceThreshold);
  return whole.success ? whole : err("LLM_OUTPUT_LIMIT_REACHED");
}

// Each start is scanned to where its array closes, so the number tried is
// capped: a reply full of "[{" in prose would otherwise take seconds (#121).
const MAX_ARRAY_STARTS = 20;

/**
 * Offsets of the first "[" characters that can start the findings array: one
 * followed, after whitespace, by "{" or "]". A "[" in the prose (`items[0]`,
 * `[src/a.ts]`) is never one (#121).
 */
function findingsArrayStarts(text: string): number[] {
  const starts: number[] = [];
  for (const match of text.matchAll(/\[(?=\s*[{\]])/g)) {
    if (starts.length === MAX_ARRAY_STARTS) break;
    starts.push(match.index);
  }
  return starts;
}

/**
 * The first array holding a valid finding, else the first array. An example
 * the model echoes before its findings (`[{"foo": "bar"}]`) holds none, so it
 * doesn't hide the real findings after it.
 */
function pickFindingsArray(
  arrays: readonly (unknown[] | null)[],
): unknown[] | null {
  const parsed = arrays.filter((items) => items !== null);
  return (
    parsed.find((items) => items.some((item) => validateFinding(item))) ??
    parsed[0] ??
    null
  );
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
  const scan = scanArray(text, arrayStart);
  if (scan.closedAt !== null) return text.slice(arrayStart, scan.closedAt + 1);
  return scan.lastItemEnd === null
    ? null
    : `${text.slice(arrayStart, scan.lastItemEnd + 1)}]`;
}

interface ArrayScan {
  readonly closedAt: number | null;
  readonly lastItemEnd: number | null;
}

function scanArray(text: string, arrayStart: number): ArrayScan {
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
      if (depth === 0) return { closedAt: i, lastItemEnd };
      if (depth === 1) lastItemEnd = i;
    }
  }
  return { closedAt: null, lastItemEnd };
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

const CODE_FENCE_PATTERN = /```(?:json)?[^\S\n]*\n?([\s\S]*?)\n?\s*```/g;

/**
 * Finds the findings array in a reply: the whole reply, then each code fence,
 * then each closed array in the text. Prose before or after it and other
 * fences don't matter (#121).
 */
function extractFindingsArray(text: string): unknown[] | null {
  return pickFindingsArray(
    candidateArrayTexts(text.trim()).map(parseJsonArray),
  );
}

function candidateArrayTexts(text: string): string[] {
  const fenced = [...text.matchAll(CODE_FENCE_PATTERN)].map((match) =>
    (match[1] ?? "").trim(),
  );
  const closedArrays = findingsArrayStarts(text).flatMap((arrayStart) => {
    const closedAt = scanArray(text, arrayStart).closedAt;
    return closedAt === null ? [] : [text.slice(arrayStart, closedAt + 1)];
  });
  return [text, ...fenced, ...closedArrays];
}

function parseJsonArray(text: string): unknown[] | null {
  if (!text.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

  const category = toEnumValue<CommentCategory>(obj.category, VALID_CATEGORIES);
  const severity = toEnumValue<CommentSeverity>(obj.severity, VALID_SEVERITIES);

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

/** The upper-cased value when it is one of `allowed`, otherwise null. */
function toEnumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  return allowed.has(upper) ? (upper as T) : null;
}
