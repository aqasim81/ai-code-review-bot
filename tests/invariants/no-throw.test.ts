// Invariant 4 (CLAUDE.md): business logic returns a Result and never throws.
// Env validation fails fast at startup and the queue processor throws so
// BullMQ retries; any other throw in src/lib/ needs a `throw-ok:` comment on
// the line before, saying where it is caught and turned into a Result.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const LIB = path.join(ROOT, "src", "lib");
const ALLOWED_FILES = new Set([
  path.join(LIB, "env.ts"),
  path.join(LIB, "queue", "processor.ts"),
]);
const ALLOW_MARKER = "throw-ok:";

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

function findUnmarkedThrows(source: string): number[] {
  const lines = source.split("\n");
  return lines.flatMap((line, index) => {
    if (isComment(line) || !/\bthrow\b/.test(line)) return [];
    const previous = lines[index - 1] ?? "";
    return previous.includes(ALLOW_MARKER) ? [] : [index + 1];
  });
}

function listTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) return listTypeScriptFiles(fullPath);
    return /\.tsx?$/.test(entry) ? [fullPath] : [];
  });
}

describe("findUnmarkedThrows", () => {
  it("flags a throw statement and a rethrow", () => {
    expect(findUnmarkedThrows('throw new Error("x");\nthrow error;')).toEqual([
      1, 2,
    ]);
  });

  it("allows a throw marked on the line before, and ignores comments", () => {
    const source = [
      "// throw-ok: caught by the caller's try/catch",
      "if (!ok) throw error;",
      "// never throws",
      " * @throws nothing",
    ].join("\n");

    expect(findUnmarkedThrows(source)).toEqual([]);
  });
});

describe("invariant 4: business logic never throws", () => {
  it("finds no unmarked throw in src/lib/ outside env.ts and the processor", () => {
    const violations = listTypeScriptFiles(LIB)
      .filter((file) => !ALLOWED_FILES.has(file))
      .flatMap((file) =>
        findUnmarkedThrows(readFileSync(file, "utf-8")).map(
          (line) => `${path.relative(ROOT, file)}:${line}`,
        ),
      );

    expect(violations).toEqual([]);
  });
});
