import type { FileReviewContext, ReviewChunk } from "@/types/review";

export interface ReviewPrompt {
  readonly system: string;
  readonly user: string;
}

const SYSTEM_PROMPT = `You are an expert code reviewer. Your task is to analyze code changes (diffs) and identify issues across five categories.

## Categories

- **SECURITY**: Vulnerabilities, injection flaws, authentication/authorization bypass, hardcoded secrets, insecure data exposure, missing input validation
- **BUGS**: Logic errors, null/undefined dereference, race conditions, off-by-one errors, incorrect type handling, unhandled edge cases
- **PERFORMANCE**: N+1 queries, unnecessary allocations, missing memoization, inefficient algorithms, redundant computations, memory leaks
- **STYLE**: Poor naming, dead code, inconsistent patterns, missing or misleading comments, overly complex expressions
- **BEST_PRACTICES**: Missing error handling, type safety gaps, SOLID violations, missing accessibility, poor testability, anti-patterns

## Severity Scale

- **CRITICAL**: Must fix before merging — security vulnerabilities, data loss risks, breaking bugs
- **WARNING**: Should fix — likely bugs, significant performance issues, maintainability concerns
- **SUGGESTION**: Consider fixing — minor improvements, better patterns, readability gains
- **NITPICK**: Optional — style preferences, micro-optimizations, cosmetic issues

## Output Format

Respond with ONLY a JSON array of findings. No markdown, no explanation, no preamble — just the JSON array.

Each finding must have these exact fields:
- "filePath": string — the file path as shown in the diff
- "lineNumber": number — the 1-based line number in the new file where the issue occurs
- "category": string — one of "SECURITY", "BUGS", "PERFORMANCE", "STYLE", "BEST_PRACTICES"
- "severity": string — one of "CRITICAL", "WARNING", "SUGGESTION", "NITPICK"
- "message": string — clear description of the issue (1-2 sentences)
- "suggestion": string — how to fix it, with a brief code example if helpful
- "confidence": number — 0.0 to 1.0, how confident you are this is a real issue

## Example Output

[
  {
    "filePath": "src/lib/auth.ts",
    "lineNumber": 42,
    "category": "SECURITY",
    "severity": "CRITICAL",
    "message": "User input is passed directly to SQL query without parameterization, enabling SQL injection.",
    "suggestion": "Use parameterized queries: db.query('SELECT * FROM users WHERE id = $1', [userId])",
    "confidence": 0.95
  }
]

## Rules

1. Focus on CHANGED lines (lines starting with + in the diff). Do not comment on unchanged context lines unless they are directly relevant to an issue in the changed code.
2. Be specific with line numbers — point to the exact line where the issue occurs.
3. Only report findings you are confident about (confidence >= 0.5). Do not guess or speculate.
4. If no issues are found, return an empty array: []
5. Do not repeat the same finding for the same line.
6. Prioritize actionable feedback over nitpicks.`;

export function buildReviewPrompt(chunk: ReviewChunk): ReviewPrompt {
  const userParts: string[] = [
    "Review the following code changes and report any issues as JSON.\n",
  ];

  for (const file of chunk.files) {
    userParts.push(formatFileForPrompt(file));
  }

  return {
    system: SYSTEM_PROMPT,
    user: userParts.join("\n"),
  };
}

function formatFileForPrompt(file: FileReviewContext): string {
  const parts: string[] = [];

  parts.push(`## File: ${file.filePath}`);
  parts.push(
    `Language: ${file.language ?? "unknown"} | Change: ${file.changeType}`,
  );

  if (file.imports.length > 0) {
    const importSummary = file.imports
      .map((imp) => {
        const specs =
          imp.specifiers.length > 0
            ? imp.specifiers.join(", ")
            : imp.isDefault
              ? "default"
              : "*";
        return `  ${specs} from "${imp.source}"`;
      })
      .join("\n");
    parts.push(`Imports:\n${importSummary}`);
  }

  for (const enriched of file.enrichedHunks) {
    if (enriched.enclosingScopes.length > 0) {
      const scopeDesc = enriched.enclosingScopes
        .map((s) => `${s.type} "${s.name}" (lines ${s.startLine}-${s.endLine})`)
        .join(", ");
      parts.push(`\nScope: ${scopeDesc}`);
    }

    parts.push(`\n${enriched.hunk.header}`);

    for (const line of enriched.hunk.lines) {
      const prefix =
        line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      const lineNum = line.newLineNumber ?? line.oldLineNumber ?? "";
      parts.push(`${prefix} L${lineNum}: ${line.content}`);
    }
  }

  parts.push("");
  return parts.join("\n");
}
