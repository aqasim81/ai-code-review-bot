import fc from "fast-check";

type GeneratedLineType = "added" | "removed" | "context";

interface GeneratedLine {
  readonly type: GeneratedLineType;
  readonly content: string;
}

interface GeneratedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly GeneratedLine[];
}

interface GeneratedFile {
  readonly filePath: string;
  readonly hunks: readonly GeneratedHunk[];
}

export interface GeneratedDiff {
  readonly raw: string;
  readonly files: readonly GeneratedFile[];
}

const LINE_PREFIXES: Record<GeneratedLineType, string> = {
  added: "+",
  removed: "-",
  context: " ",
};

// Line contents that look like diff syntax, next to arbitrary text.
const DIFF_LOOKALIKE_CONTENT = [
  "",
  " ",
  "--- a/src/other.ts",
  "+++ b/src/other.ts",
  "-- a/src/other.ts",
  "++ b/src/other.ts",
  "@@ -1,2 +1,2 @@",
  "diff --git a/x.ts b/x.ts",
  "\\ No newline at end of file",
  "rename from src/old.ts",
  "new file mode 100644",
  "Binary files a/x and b/x differ",
] as const;

const lineContentArbitrary: fc.Arbitrary<string> = fc
  .oneof(
    fc.constantFrom(...DIFF_LOOKALIKE_CONTENT),
    fc.string({ unit: "grapheme", maxLength: 20 }),
    fc.string({ maxLength: 20 }),
  )
  .map((content) => content.replaceAll("\n", ""));

const lineArbitrary: fc.Arbitrary<GeneratedLine> = fc.record({
  type: fc.constantFrom<GeneratedLineType>("added", "removed", "context"),
  content: lineContentArbitrary,
});

const hunkShapeArbitrary = fc.record({
  gapBefore: fc.nat({ max: 20 }),
  lines: fc.array(lineArbitrary, { minLength: 1, maxLength: 12 }),
});

function countLines(
  lines: readonly GeneratedLine[],
  side: "old" | "new",
): number {
  const excluded: GeneratedLineType = side === "old" ? "added" : "removed";
  return lines.filter((line) => line.type !== excluded).length;
}

/**
 * Lays hunks out in file order: each starts after the previous one ends plus
 * a gap of unchanged lines, which moves the old and new positions alike.
 */
function placeHunks(
  shapes: readonly { gapBefore: number; lines: GeneratedLine[] }[],
): GeneratedHunk[] {
  let nextOld = 1;
  let nextNew = 1;
  return shapes.map(({ gapBefore, lines }) => {
    const oldStart = nextOld + gapBefore;
    const newStart = nextNew + gapBefore;
    const oldCount = countLines(lines, "old");
    const newCount = countLines(lines, "new");
    nextOld = oldStart + oldCount;
    nextNew = newStart + newCount;
    return { oldStart, oldCount, newStart, newCount, lines };
  });
}

function renderHunk(hunk: GeneratedHunk, sectionHeading: string): string[] {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${sectionHeading}`;
  return [
    header,
    ...hunk.lines.map((line) => `${LINE_PREFIXES[line.type]}${line.content}`),
  ];
}

function renderFile(
  file: GeneratedFile,
  sectionHeading: string,
  endsWithoutNewline: boolean,
): string[] {
  const body = file.hunks.flatMap((hunk) => renderHunk(hunk, sectionHeading));
  return [
    `diff --git a/${file.filePath} b/${file.filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${file.filePath}`,
    `+++ b/${file.filePath}`,
    ...body,
    ...(endsWithoutNewline ? ["\\ No newline at end of file"] : []),
  ];
}

const FILE_PATHS = [
  "src/a.ts",
  "src/b.py",
  "lib/c.go",
  "d.rs",
  "src/nested/e.java",
] as const;

/**
 * A unified diff of modified files with known hunks, rendered the way git
 * prints it, alongside the files and hunks it was built from.
 */
export const generatedDiffArbitrary: fc.Arbitrary<GeneratedDiff> = fc
  .record({
    paths: fc.uniqueArray(fc.constantFrom(...FILE_PATHS), {
      minLength: 1,
      maxLength: 3,
    }),
    hunkShapes: fc.array(
      fc.array(hunkShapeArbitrary, { minLength: 1, maxLength: 4 }),
      { minLength: 3, maxLength: 3 },
    ),
    sectionHeading: fc.constantFrom("", " function example() {"),
    endsWithoutNewline: fc.boolean(),
  })
  .map(({ paths, hunkShapes, sectionHeading, endsWithoutNewline }) => {
    const files = paths.map((filePath, index) => ({
      filePath,
      hunks: placeHunks(hunkShapes[index] ?? []),
    }));
    const raw = files
      .flatMap((file) => renderFile(file, sectionHeading, endsWithoutNewline))
      .join("\n");
    return { raw: `${raw}\n`, files };
  });

/**
 * Whether the diff's last line ends in whitespace (a blank context line, or
 * an added or removed line with trailing spaces). parseUnifiedDiff trims the
 * whole diff and loses that whitespace: #108.
 */
export function lastDiffLineEndsInWhitespace(raw: string): boolean {
  return /\s$/.test(raw.replace(/\n$/, ""));
}
