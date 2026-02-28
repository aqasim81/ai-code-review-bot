import type { ContextBuildError } from "@/types/errors";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type {
  AstFileContext,
  AstScope,
  DiffHunk,
  EnrichedHunk,
  FileReviewContext,
  ParsedDiff,
  ParsedDiffFile,
  ReviewChunk,
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

export function buildReviewContext(
  parsedDiff: ParsedDiff,
  astContexts: ReadonlyMap<string, AstFileContext>,
  fileContents: ReadonlyMap<string, string>,
  options?: BuildReviewContextOptions,
): Result<readonly ReviewChunk[], ContextBuildError> {
  const maxTokens = options?.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK;

  const reviewableFiles = filterReviewableFiles(parsedDiff.files);
  if (reviewableFiles.length === 0) {
    return err("CONTEXT_NO_REVIEWABLE_FILES");
  }

  const fileContexts = reviewableFiles.map((file) =>
    buildFileReviewContext(
      file,
      astContexts.get(file.filePath),
      fileContents.get(file.filePath) ?? null,
    ),
  );

  const prioritized = prioritizeFiles(fileContexts);
  const chunks = chunkFileContexts(prioritized, maxTokens);

  return ok(chunks);
}

function filterReviewableFiles(
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
  fileContent: string | null,
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
    fullFileContent: fileContent,
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

function prioritizeFiles(files: FileReviewContext[]): FileReviewContext[] {
  return [...files].sort((a, b) => {
    const aSecure = isSecuritySensitiveFile(a.filePath) ? 0 : 1;
    const bSecure = isSecuritySensitiveFile(b.filePath) ? 0 : 1;
    if (aSecure !== bSecure) {
      return aSecure - bSecure;
    }
    return countChangedLines(b) - countChangedLines(a);
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
  files: FileReviewContext[],
  maxTokensPerChunk: number,
): ReviewChunk[] {
  const chunks: ReviewChunk[] = [];
  let currentFiles: FileReviewContext[] = [];
  let currentTokenCount = 0;

  for (const file of files) {
    const fileTokens = estimateFileTokenCount(file);

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
