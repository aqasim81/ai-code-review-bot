import type {
  AstFileContext,
  AstScope,
  DiffHunk,
  EnrichedHunk,
  FileReviewContext,
  ParsedDiff,
  ParsedDiffFile,
  ReviewChunk,
  ReviewContext,
} from "@/types/review";

const DEFAULT_MAX_TOKENS_PER_CHUNK = 30_000;

const SECURITY_SENSITIVE_PATTERNS = [
  /auth/i,
  /login/i,
  /password/i,
  /secret/i,
  /token/i,
  /crypto/i,
  /encrypt/i,
  /decrypt/i,
  /session/i,
  /permission/i,
  /\.env/,
  /credential/i,
  /oauth/i,
  /jwt/i,
  /sanitiz/i,
  /injection/i,
];

interface BuildReviewContextOptions {
  readonly maxTokensPerChunk?: number;
}

/** Chunks are empty when no file in the diff is reviewable. */
export function buildReviewContext(
  parsedDiff: ParsedDiff,
  astContexts: ReadonlyMap<string, AstFileContext>,
  options?: BuildReviewContextOptions,
): ReviewContext {
  const maxTokens = options?.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK;

  const files = filterReviewableFiles(parsedDiff.files).map((file) =>
    measureFile(buildFileReviewContext(file, astContexts.get(file.filePath))),
  );

  // A file larger than a whole chunk cannot be sent in one request, and would
  // fail the review on every attempt; skip it and report it instead.
  const fitting: MeasuredFile[] = [];
  const oversizedFilePaths: string[] = [];
  for (const file of prioritizeFiles(files)) {
    if (file.tokens > maxTokens) {
      oversizedFilePaths.push(file.context.filePath);
    } else {
      fitting.push(file);
    }
  }

  return {
    chunks: chunkFileContexts(fitting, maxTokens),
    oversizedFilePaths,
  };
}

/** Files with changes to review: not binary, not deleted, with hunks. */
export function filterReviewableFiles(
  files: readonly ParsedDiffFile[],
): ParsedDiffFile[] {
  return files.filter(
    (file) =>
      !file.isBinary && file.changeType !== "deleted" && file.hunks.length > 0,
  );
}

function buildFileReviewContext(
  file: ParsedDiffFile,
  astContext: AstFileContext | undefined,
): FileReviewContext {
  const scopes = astContext?.scopes ?? [];
  const imports = astContext?.imports ?? [];

  const enrichedHunks: EnrichedHunk[] = file.hunks.map((hunk) => ({
    hunk,
    enclosingScopes: findEnclosingScopesForHunk(hunk, scopes),
  }));

  return {
    filePath: file.filePath,
    language: file.language,
    changeType: file.changeType,
    enrichedHunks,
    imports,
  };
}

function findEnclosingScopesForHunk(
  hunk: DiffHunk,
  scopes: readonly AstScope[],
): AstScope[] {
  const hunkStartLine = hunk.newStart;
  const hunkEndLine = hunk.newStart + hunk.newCount - 1;

  return scopes.filter(
    (scope) => scope.startLine <= hunkEndLine && scope.endLine >= hunkStartLine,
  );
}

function isSecuritySensitiveFile(filePath: string): boolean {
  return SECURITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(filePath));
}

function countChangedLines(context: FileReviewContext): number {
  let count = 0;
  for (const enriched of context.enrichedHunks) {
    for (const line of enriched.hunk.lines) {
      if (line.type === "added" || line.type === "removed") {
        count++;
      }
    }
  }
  return count;
}

/** A file context with the values sorting and chunking need, computed once. */
interface MeasuredFile {
  readonly context: FileReviewContext;
  readonly securitySensitive: boolean;
  readonly changedLines: number;
  readonly tokens: number;
}

function measureFile(context: FileReviewContext): MeasuredFile {
  return {
    context,
    securitySensitive: isSecuritySensitiveFile(context.filePath),
    changedLines: countChangedLines(context),
    tokens: estimateFileTokenCount(context),
  };
}

function prioritizeFiles(files: readonly MeasuredFile[]): MeasuredFile[] {
  return [...files].sort((a, b) => {
    if (a.securitySensitive !== b.securitySensitive) {
      return a.securitySensitive ? -1 : 1;
    }
    return b.changedLines - a.changedLines;
  });
}

function estimateFileTokenCount(context: FileReviewContext): number {
  let charCount = 0;

  charCount += context.filePath.length;

  for (const enriched of context.enrichedHunks) {
    for (const line of enriched.hunk.lines) {
      charCount += line.content.length + 10;
    }
    for (const scope of enriched.enclosingScopes) {
      charCount += scope.name.length + scope.type.length + 20;
    }
  }

  for (const imp of context.imports) {
    charCount += imp.source.length + 20;
  }

  return Math.ceil(charCount / 4);
}

function chunkFileContexts(
  files: readonly MeasuredFile[],
  maxTokensPerChunk: number,
): ReviewChunk[] {
  const chunks: ReviewChunk[] = [];
  let currentFiles: FileReviewContext[] = [];
  let currentTokenCount = 0;

  for (const { context: file, tokens: fileTokens } of files) {
    if (
      currentFiles.length > 0 &&
      currentTokenCount + fileTokens > maxTokensPerChunk
    ) {
      chunks.push({
        files: currentFiles,
        estimatedTokenCount: currentTokenCount,
      });
      currentFiles = [];
      currentTokenCount = 0;
    }

    currentFiles.push(file);
    currentTokenCount += fileTokens;
  }

  if (currentFiles.length > 0) {
    chunks.push({
      files: currentFiles,
      estimatedTokenCount: currentTokenCount,
    });
  }

  return chunks;
}
