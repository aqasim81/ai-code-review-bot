import type {
  CommentCategory,
  CommentSeverity,
} from "@/generated/prisma/enums";

// --- Supported languages ---

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java";

// --- Diff Parser output types ---

export type DiffLineType = "added" | "removed" | "context";

export interface DiffLine {
  readonly type: DiffLineType;
  readonly content: string;
  /** 1-based line number in the new file (null for removed lines) */
  readonly newLineNumber: number | null;
  /** 1-based line number in the old file (null for added lines) */
  readonly oldLineNumber: number | null;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export type FileChangeType = "added" | "modified" | "deleted" | "renamed";

export interface ParsedDiffFile {
  readonly filePath: string;
  readonly previousFilePath: string | null;
  readonly changeType: FileChangeType;
  readonly language: SupportedLanguage | null;
  readonly hunks: readonly DiffHunk[];
  readonly isBinary: boolean;
}

export interface ParsedDiff {
  readonly files: readonly ParsedDiffFile[];
}

// --- AST Parser output types ---

export type ScopeType = "function" | "method" | "class";

export interface AstScope {
  readonly type: ScopeType;
  readonly name: string;
  /** 1-based start line */
  readonly startLine: number;
  /** 1-based end line */
  readonly endLine: number;
}

export interface AstImport {
  readonly source: string;
  readonly specifiers: readonly string[];
  readonly isDefault: boolean;
}

export interface AstFileContext {
  readonly filePath: string;
  readonly language: SupportedLanguage;
  readonly scopes: readonly AstScope[];
  readonly imports: readonly AstImport[];
}

// --- Context Builder output types ---

export interface EnrichedHunk {
  readonly hunk: DiffHunk;
  readonly enclosingScopes: readonly AstScope[];
}

export interface FileReviewContext {
  readonly filePath: string;
  readonly language: SupportedLanguage | null;
  readonly changeType: FileChangeType;
  readonly enrichedHunks: readonly EnrichedHunk[];
  readonly imports: readonly AstImport[];
  readonly fullFileContent: string | null;
}

export interface ReviewChunk {
  readonly files: readonly FileReviewContext[];
  readonly estimatedTokenCount: number;
}

// --- LLM output types ---

export interface ReviewFinding {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly category: CommentCategory;
  readonly severity: CommentSeverity;
  readonly message: string;
  readonly suggestion: string;
  readonly confidence: number;
}

export interface ReviewResult {
  readonly findings: readonly ReviewFinding[];
  readonly summary: string;
  readonly tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}
