/**
 * LLM response string fixtures for testing parseLlmReviewResponse().
 */

export const VALID_JSON_ARRAY = `[
  {
    "filePath": "src/lib/auth.ts",
    "lineNumber": 5,
    "category": "security",
    "severity": "critical",
    "message": "Hardcoded secret detected in source code",
    "suggestion": "Use environment variables for secrets",
    "confidence": 0.95
  },
  {
    "filePath": "src/lib/utils.ts",
    "lineNumber": 12,
    "category": "bugs",
    "severity": "warning",
    "message": "Potential null reference when accessing property",
    "suggestion": "Add null check before accessing .name",
    "confidence": 0.82
  }
]`;

export const VALID_MARKDOWN_FENCED = `Here are my findings:

\`\`\`json
[
  {
    "filePath": "src/lib/handler.ts",
    "lineNumber": 8,
    "category": "performance",
    "severity": "suggestion",
    "message": "Unnecessary array copy in hot path",
    "suggestion": "Use Array.from() instead of spread operator for large arrays",
    "confidence": 0.75
  }
]
\`\`\``;

export const VALID_WITH_PREAMBLE = `After reviewing the code changes, I found the following issues:

[
  {
    "filePath": "src/lib/db.ts",
    "lineNumber": 22,
    "category": "best_practices",
    "severity": "nitpick",
    "message": "Missing error handling for database query",
    "suggestion": "Wrap in try/catch and return Result type",
    "confidence": 0.88
  }
]`;

export const EMPTY_ARRAY = "[]";

export const INVALID_JSON = "This is not valid JSON at all { broken [";

export const NON_ARRAY_JSON = `{
  "filePath": "src/lib/auth.ts",
  "lineNumber": 5,
  "category": "security",
  "severity": "critical",
  "message": "Not an array",
  "suggestion": "Wrap in array",
  "confidence": 0.9
}`;

export const MIXED_CONFIDENCE = `[
  {
    "filePath": "src/lib/high.ts",
    "lineNumber": 1,
    "category": "bugs",
    "severity": "warning",
    "message": "High confidence issue",
    "suggestion": "Fix this",
    "confidence": 0.95
  },
  {
    "filePath": "src/lib/low.ts",
    "lineNumber": 2,
    "category": "style",
    "severity": "nitpick",
    "message": "Low confidence issue",
    "suggestion": "Maybe fix this",
    "confidence": 0.3
  },
  {
    "filePath": "src/lib/threshold.ts",
    "lineNumber": 3,
    "category": "performance",
    "severity": "suggestion",
    "message": "At threshold issue",
    "suggestion": "Consider fixing",
    "confidence": 0.7
  }
]`;

export const MISSING_FIELDS = `[
  {
    "filePath": "src/lib/good.ts",
    "lineNumber": 1,
    "category": "bugs",
    "severity": "warning",
    "message": "Valid finding",
    "suggestion": "Fix it",
    "confidence": 0.85
  },
  {
    "lineNumber": 5,
    "category": "bugs",
    "severity": "warning",
    "message": "Missing filePath"
  },
  {
    "filePath": "src/lib/no-line.ts",
    "category": "bugs",
    "severity": "warning",
    "message": "Missing lineNumber",
    "suggestion": "Fix it",
    "confidence": 0.8
  }
]`;

export const INVALID_CATEGORY = `[
  {
    "filePath": "src/lib/bad-cat.ts",
    "lineNumber": 1,
    "category": "invalid_category",
    "severity": "warning",
    "message": "Invalid category value",
    "suggestion": "Fix it",
    "confidence": 0.85
  }
]`;

export const INVALID_SEVERITY = `[
  {
    "filePath": "src/lib/bad-sev.ts",
    "lineNumber": 1,
    "category": "bugs",
    "severity": "invalid_severity",
    "message": "Invalid severity value",
    "suggestion": "Fix it",
    "confidence": 0.85
  }
]`;

export const OUT_OF_RANGE_CONFIDENCE = `[
  {
    "filePath": "src/lib/neg.ts",
    "lineNumber": 1,
    "category": "bugs",
    "severity": "warning",
    "message": "Negative confidence",
    "suggestion": "Fix it",
    "confidence": -0.5
  },
  {
    "filePath": "src/lib/over.ts",
    "lineNumber": 2,
    "category": "bugs",
    "severity": "warning",
    "message": "Over 1 confidence",
    "suggestion": "Fix it",
    "confidence": 1.5
  }
]`;

export const NO_JSON_CONTENT =
  "I reviewed the code and everything looks great! No issues found.";
