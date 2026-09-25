import { describe, expect, it } from "vitest";
import {
  canManageRepository,
  EMPTY_USER_ACCESS,
  parseUserAccess,
} from "@/lib/github/repository-access";

const ACCESS = {
  githubInstallationIds: [10],
  accessibleGithubRepoIds: [1, 2],
  manageableGithubRepoIds: [1],
  truncated: false,
};

describe("parseUserAccess", () => {
  it("returns well-formed access unchanged", () => {
    expect(parseUserAccess(ACCESS)).toEqual(ACCESS);
  });

  it("grants nothing for a token issued before repository-level access", () => {
    expect(parseUserAccess(undefined)).toEqual(EMPTY_USER_ACCESS);
    expect(parseUserAccess({ installationIds: [10] })).toEqual(
      EMPTY_USER_ACCESS,
    );
  });

  it("grants nothing when any list holds a non-integer", () => {
    expect(
      parseUserAccess({ ...ACCESS, accessibleGithubRepoIds: [1, "2"] }),
    ).toEqual(EMPTY_USER_ACCESS);
    expect(
      parseUserAccess({ ...ACCESS, githubInstallationIds: [1.5] }),
    ).toEqual(EMPTY_USER_ACCESS);
    expect(parseUserAccess({ ...ACCESS, truncated: "no" })).toEqual(
      EMPTY_USER_ACCESS,
    );
  });

  it("never lets a repository be manageable without being accessible", () => {
    const parsed = parseUserAccess({
      ...ACCESS,
      manageableGithubRepoIds: [1, 3],
    });

    expect(parsed.manageableGithubRepoIds).toEqual([1]);
  });
});

describe("canManageRepository", () => {
  it("allows only repositories with admin or maintain permission", () => {
    expect(canManageRepository(ACCESS, 1)).toBe(true);
    expect(canManageRepository(ACCESS, 2)).toBe(false);
    expect(canManageRepository(ACCESS, 99)).toBe(false);
  });
});
