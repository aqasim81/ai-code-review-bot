import type { DiffParseError } from "@/types/errors";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type {
  DiffHunk,
  DiffLine,
  FileChangeType,
  ParsedDiff,
  ParsedDiffFile,
  SupportedLanguage,
} from "@/types/review";

const NON_REVIEWABLE_PATTERNS = [
  /[-.]lock\./,
  /\.lock$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /\.wasm$/,
  /\.png$/,
  /\.jpe?g$/,
  /\.gif$/,
  /\.svg$/,
  /\.ico$/,
  /\.webp$/,
  /\.map$/,
  /^src\/generated\//,
  /^node_modules\//,
];

const LANGUAGE_EXTENSIONS: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

const HUNK_HEADER_REGEX =
  /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

export function parseUnifiedDiff(
  rawDiff: string,
): Result<ParsedDiff, DiffParseError> {
  const trimmed = rawDiff.trim();
  if (trimmed.length === 0) {
    return err("DIFF_EMPTY");
  }

  const fileBlocks = splitIntoFileBlocks(trimmed);
  const files: ParsedDiffFile[] = [];

  for (const block of fileBlocks) {
    const parsed = parseFileDiff(block);
    if (parsed !== null) {
      files.push(parsed);
    }
  }

  return ok({ files });
}

function splitIntoFileBlocks(rawDiff: string): string[] {
  const parts = rawDiff.split(/^diff --git /m);
  return parts.filter((part) => part.trim().length > 0);
}

function parseFileDiff(block: string): ParsedDiffFile | null {
  const lines = block.split("\n");
  const filePath = extractFilePath(lines);
  if (filePath === null) {
    return null;
  }

  if (!isReviewableFile(filePath)) {
    return null;
  }

  const isBinary = lines.some(
    (line) =>
      line.startsWith("Binary files") || line.includes("GIT binary patch"),
  );

  if (isBinary) {
    return {
      filePath,
      previousFilePath: extractPreviousFilePath(lines),
      changeType: detectFileChangeType(lines),
      language: detectLanguageFromFilePath(filePath),
      hunks: [],
      isBinary: true,
    };
  }

  const hunks = parseHunks(lines);

  return {
    filePath,
    previousFilePath: extractPreviousFilePath(lines),
    changeType: detectFileChangeType(lines),
    language: detectLanguageFromFilePath(filePath),
    hunks,
    isBinary: false,
  };
}

function extractFilePath(lines: string[]): string | null {
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      return line.slice("+++ b/".length);
    }
    if (line.startsWith("+++ /dev/null")) {
      // Deleted file — use the old path
      for (const oldLine of lines) {
        if (oldLine.startsWith("--- a/")) {
          return oldLine.slice("--- a/".length);
        }
      }
      return null;
    }
  }

  // Fallback: extract from the first line (e.g., "a/path b/path")
  const firstLine = lines[0];
  if (firstLine !== undefined) {
    const match = firstLine.match(/^a\/.+ b\/(.+)$/);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }

  return null;
}

function extractPreviousFilePath(lines: string[]): string | null {
  for (const line of lines) {
    if (line.startsWith("rename from ")) {
      return line.slice("rename from ".length);
    }
  }

  const oldPath = lines.find((line) => line.startsWith("--- a/"));
  const newPath = lines.find((line) => line.startsWith("+++ b/"));
  if (
    oldPath !== undefined &&
    newPath !== undefined &&
    oldPath.slice("--- a/".length) !== newPath.slice("+++ b/".length)
  ) {
    return oldPath.slice("--- a/".length);
  }

  return null;
}

function detectFileChangeType(lines: string[]): FileChangeType {
  for (const line of lines) {
    if (line.startsWith("new file mode")) {
      return "added";
    }
    if (line.startsWith("deleted file mode")) {
      return "deleted";
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      return "renamed";
    }
  }

  if (lines.some((line) => line.startsWith("--- /dev/null"))) {
    return "added";
  }
  if (lines.some((line) => line.startsWith("+++ /dev/null"))) {
    return "deleted";
  }

  return "modified";
}

function detectLanguageFromFilePath(
  filePath: string,
): SupportedLanguage | null {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  const extension = filePath.slice(dotIndex);
  return LANGUAGE_EXTENSIONS[extension] ?? null;
}

function isReviewableFile(filePath: string): boolean {
  return !NON_REVIEWABLE_PATTERNS.some((pattern) => pattern.test(filePath));
}

function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunkLines: string[] = [];
  let currentHeader: string | null = null;
  let currentMatch: RegExpExecArray | null = null;

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_REGEX.exec(line);
    if (hunkMatch !== null) {
      if (currentHeader !== null && currentMatch !== null) {
        hunks.push(
          buildDiffHunk(currentHeader, currentMatch, currentHunkLines),
        );
      }
      currentHeader = line;
      currentMatch = hunkMatch;
      currentHunkLines = [];
    } else if (currentHeader !== null) {
      currentHunkLines.push(line);
    }
  }

  if (currentHeader !== null && currentMatch !== null) {
    hunks.push(buildDiffHunk(currentHeader, currentMatch, currentHunkLines));
  }

  return hunks;
}

function buildDiffHunk(
  header: string,
  match: RegExpExecArray,
  rawLines: string[],
): DiffHunk {
  const oldStart = Number.parseInt(match[1] ?? "1", 10);
  const oldCount = Number.parseInt(match[2] ?? "1", 10);
  const newStart = Number.parseInt(match[3] ?? "1", 10);
  const newCount = Number.parseInt(match[4] ?? "1", 10);

  let oldLine = oldStart;
  let newLine = newStart;
  const parsedLines: DiffLine[] = [];

  for (const raw of rawLines) {
    if (raw.startsWith("+")) {
      parsedLines.push({
        type: "added",
        content: raw.slice(1),
        newLineNumber: newLine,
        oldLineNumber: null,
      });
      newLine++;
    } else if (raw.startsWith("-")) {
      parsedLines.push({
        type: "removed",
        content: raw.slice(1),
        newLineNumber: null,
        oldLineNumber: oldLine,
      });
      oldLine++;
    } else if (raw.startsWith(" ")) {
      parsedLines.push({
        type: "context",
        content: raw.slice(1),
        newLineNumber: newLine,
        oldLineNumber: oldLine,
      });
      oldLine++;
      newLine++;
    } else if (raw === "\\ No newline at end of file") {
      // Skip this marker — it's metadata, not a code line
    }
    // Ignore other lines (empty trailing lines, etc.)
  }

  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
    header,
    lines: parsedLines,
  };
}
