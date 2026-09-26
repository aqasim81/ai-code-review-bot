import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { config } from "@/middleware";

// A server component's auth() can't set cookies: a GitHub token it refreshed
// would be lost after using up the single-use refresh token. Middleware can,
// so every page that reads the session must be behind it (#130).
function pagesReadingTheSession(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return pagesReadingTheSession(path);
    if (!/^(page|layout)\.tsx$/.test(entry)) return [];
    const source = readFileSync(path, "utf8");
    return /\b(auth|getSession)\(\)/.test(source) ? [path] : [];
  });
}

function routeOf(pagePath: string): string {
  const route = relative("src/app", pagePath)
    .replace(/(^|\/)(page|layout)\.tsx$/, "")
    .replace(/\[[^\]]+\]/g, "x");
  return `/${route}`;
}

function matches(matcher: string, route: string): boolean {
  if (matcher.endsWith("/:path*")) {
    const base = matcher.slice(0, -"/:path*".length);
    return route === base || route.startsWith(`${base}/`);
  }
  return matcher === route;
}

describe("middleware matcher (#130)", () => {
  const pages = pagesReadingTheSession("src/app");

  it("finds the pages that read the session", () => {
    expect(pages.map(routeOf)).toContain("/");
  });

  it.each(pages.map((page) => [routeOf(page)]))(
    "runs before %s, so a refreshed token reaches the cookie",
    (route) => {
      expect(config.matcher.some((matcher) => matches(matcher, route))).toBe(
        true,
      );
    },
  );
});
