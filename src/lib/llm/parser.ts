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
 * were complete before the cut and drops the partial one. The limit cuts the
 * reply inside or after its findings, so an array still open at the end is
 * the findings. A cut before any item was complete is
 * LLM_OUTPUT_LIMIT_REACHED; a closed or repaired array that is not valid
 * JSON is still LLM_INVALID_RESPONSE.
 */
export function parseTruncatedLlmReviewResponse(
  responseText: string,
  confidenceThreshold?: number,
): Result<readonly ReviewFinding[], LLMError> {
  const spans = findTopLevelArrays(responseText);
  const last = spans.at(-1);
  if (last === undefined) return err("LLM_OUTPUT_LIMIT_REACHED");
  // Every array closed: the cut came after the findings.
  if (last.closedAt !== null) {
    return parseLlmReviewResponse(responseText, confidenceThreshold);
  }
  if (last.lastItemEnd === null) return err("LLM_OUTPUT_LIMIT_REACHED");

  const items = parseJsonArray(
    `${responseText.slice(last.start, last.lastItemEnd + 1)}]`,
  );
  if (items === null) return err("LLM_INVALID_RESPONSE");
  return ok(
    validateFindings(
      items,
      confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    ),
  );
}

interface ArraySpan {
  readonly start: number;
  /** Where the array closes; null when the text ends inside it. */
  readonly closedAt: number | null;
  /** The end of its last complete item, if any. */
  readonly lastItemEnd: number | null;
}

/**
 * The arrays in the text that can hold findings, in order: each starts with a
 * "[" followed, after whitespace, by "{" or "]", so a "[" in the prose
 * (`items[0]`, `[src/a.ts]`) never starts one (#121). Arrays nested in
 * another are skipped, and an array still open at the end of the text holds
 * everything after its start, so each character is scanned once.
 */
function findTopLevelArrays(text: string): ArraySpan[] {
  const spans: ArraySpan[] = [];
  const arrayStart = /\[(?=\s*[{\]])/g;
  for (let match = arrayStart.exec(text); match !== null; ) {
    const span = { start: match.index, ...scanArray(text, match.index) };
    spans.push(span);
    if (span.closedAt === null) break;
    arrayStart.lastIndex = span.closedAt + 1;
    match = arrayStart.exec(text);
  }
  return spans;
}

/**
 * Scans JSON text from an opening "[" to where the array closes, recording
 * where its last complete item ends. Brackets inside strings are ignored.
 */
function scanArray(text: string, arrayStart: number): Omit<ArraySpan, "start"> {
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

/**
 * Finds the findings array in a reply: the whole reply if it is one, else the
 * one closed array holding valid findings, else the last closed array (an
 * empty answer). Prose around it and code fences don't matter (#121). Two
 * arrays holding findings (an example and the answer) can't be told apart,
 * so that reply is bad output, never a guess.
 */
function extractFindingsArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  const whole = parseJsonArray(trimmed);
  if (whole !== null) return whole;

  const arrays = findTopLevelArrays(trimmed).flatMap(({ start, closedAt }) => {
    if (closedAt === null) return [];
    const items = parseJsonArray(trimmed.slice(start, closedAt + 1));
    return items === null ? [] : [items];
  });
  const withFindings = arrays.filter((items) =>
    items.some((item) => validateFinding(item)),
  );
  if (withFindings.length > 1) return null;
  return withFindings[0] ?? arrays.at(-1) ?? null;
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
