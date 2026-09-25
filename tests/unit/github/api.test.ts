import { beforeEach, describe, expect, it, vi } from "vitest";

const octokitMocks = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  createInstallationAccessToken: vi.fn(),
  rateLimitGet: vi.fn(),
  paginate: vi.fn(),
  listReviews: vi.fn(),
  getContent: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    apps = {
      getAuthenticated: octokitMocks.getAuthenticated,
      createInstallationAccessToken: octokitMocks.createInstallationAccessToken,
    };
    rateLimit = { get: octokitMocks.rateLimitGet };
    pulls = {
      listReviews: octokitMocks.listReviews,
      get: octokitMocks.getPullRequest,
    };
    repos = { getContent: octokitMocks.getContent };
    paginate = octokitMocks.paginate;
  },
}));

vi.mock("node:crypto", () => ({
  createSign: () => ({ update: vi.fn(), sign: () => "signature" }),
}));

const MARKER = "<!-- code-review-bot:review=review-1 -->";

function listedReview(id: number, login: string) {
  return { id, body: `Summary\n\n${MARKER}`, user: { login, type: "Bot" } };
}

async function loadFreshApiModule() {
  vi.resetModules();
  return import("@/lib/github/api");
}

describe("findPostedReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokitMocks.createInstallationAccessToken.mockResolvedValue({
      data: { token: "installation-token" },
    });
    octokitMocks.rateLimitGet.mockResolvedValue({
      data: { resources: { core: { remaining: 5000, reset: 0 } } },
    });
    octokitMocks.getAuthenticated.mockResolvedValue({
      data: { slug: "real-app" },
    });
  });

  it("matches the review by the bot login GitHub reports for the app, not the configured slug", async () => {
    octokitMocks.paginate.mockResolvedValue([
      listedReview(1, "test-bot[bot]"),
      listedReview(2, "real-app[bot]"),
    ]);
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).findPostedReview(
      "owner",
      "repo",
      42,
      MARKER,
    );

    expect(result).toEqual({ success: true, data: { githubReviewId: 2 } });
    expect(octokitMocks.paginate).toHaveBeenCalledWith(
      octokitMocks.listReviews,
      { owner: "owner", repo: "repo", pull_number: 42, per_page: 100 },
    );
  });

  it("looks up the app's login once and reuses it", async () => {
    octokitMocks.paginate.mockResolvedValue([]);
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();
    const service = createGitHubServiceFromEnv(1);

    await service.findPostedReview("owner", "repo", 42, MARKER);
    await service.findPostedReview("owner", "repo", 43, MARKER);

    expect(octokitMocks.getAuthenticated).toHaveBeenCalledTimes(1);
  });

  it("returns an error, not null, when the app's login cannot be resolved", async () => {
    octokitMocks.getAuthenticated.mockRejectedValue(new Error("boom"));
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).findPostedReview(
      "owner",
      "repo",
      42,
      MARKER,
    );

    expect(result.success).toBe(false);
    expect(octokitMocks.paginate).not.toHaveBeenCalled();
  });

  it("returns an error when listing reviews fails", async () => {
    octokitMocks.paginate.mockRejectedValue(new Error("boom"));
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).findPostedReview(
      "owner",
      "repo",
      42,
      MARKER,
    );

    expect(result).toEqual({ success: false, error: "GITHUB_UNKNOWN_ERROR" });
  });
});

describe("fetchFileContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokitMocks.createInstallationAccessToken.mockResolvedValue({
      data: { token: "installation-token" },
    });
    octokitMocks.rateLimitGet.mockResolvedValue({
      data: { resources: { core: { remaining: 5000, reset: 0 } } },
    });
  });

  it("decodes base64 file content", async () => {
    octokitMocks.getContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from("const a = 1;\n").toString("base64"),
      },
    });
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).fetchFileContent(
      "owner",
      "repo",
      "src/a.ts",
      "sha",
    );

    expect(result).toEqual({ success: true, data: "const a = 1;\n" });
  });

  it("returns an error instead of an empty file when GitHub omits content over 1 MB", async () => {
    octokitMocks.getContent.mockResolvedValue({
      data: { type: "file", encoding: "none", content: "" },
    });
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).fetchFileContent(
      "owner",
      "repo",
      "fixtures/huge.json",
      "sha",
    );

    expect(result).toEqual({
      success: false,
      error: "GITHUB_CONTENT_TOO_LARGE",
    });
  });
});

function httpError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Error {
  return Object.assign(new Error(message), { status, response: { headers } });
}

describe("fetchPullRequestDiff error classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokitMocks.createInstallationAccessToken.mockResolvedValue({
      data: { token: "installation-token" },
    });
    octokitMocks.rateLimitGet.mockResolvedValue({
      data: { resources: { core: { remaining: 5000, reset: 0 } } },
    });
  });

  it.each([
    [
      "a 403 with no requests remaining",
      httpError(403, "API rate limit exceeded", {
        "x-ratelimit-remaining": "0",
      }),
      "GITHUB_RATE_LIMITED",
    ],
    [
      "a 403 with retry-after",
      httpError(403, "Forbidden", { "retry-after": "60" }),
      "GITHUB_RATE_LIMITED",
    ],
    [
      "a 403 secondary rate limit",
      httpError(403, "You have exceeded a secondary rate limit"),
      "GITHUB_RATE_LIMITED",
    ],
    ["a 429", httpError(429, "Too many requests"), "GITHUB_RATE_LIMITED"],
    [
      "a 403 permission error",
      httpError(403, "Resource not accessible by integration", {
        "x-ratelimit-remaining": "4999",
      }),
      "GITHUB_FORBIDDEN",
    ],
    ["a 404", httpError(404, "Not Found"), "GITHUB_NOT_FOUND"],
    [
      "a 406 diff too large",
      httpError(406, "Sorry, the diff exceeded the maximum number of lines"),
      "GITHUB_REQUEST_REJECTED",
    ],
    [
      "a 422",
      httpError(422, "Unprocessable Entity"),
      "GITHUB_REQUEST_REJECTED",
    ],
    ["a 502", httpError(502, "Bad Gateway"), "GITHUB_UNKNOWN_ERROR"],
  ])("classifies %s", async (_label, error, expected) => {
    octokitMocks.getPullRequest.mockRejectedValue(error);
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).fetchPullRequestDiff(
      "owner",
      "repo",
      42,
    );

    expect(result).toEqual({ success: false, error: expected });
  });
});

describe("installation token error classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokitMocks.rateLimitGet.mockResolvedValue({
      data: { resources: { core: { remaining: 5000, reset: 0 } } },
    });
  });

  it.each([
    [
      "a 404 for a deleted installation",
      httpError(404, "Not Found"),
      "GITHUB_INSTALLATION_UNAVAILABLE",
    ],
    [
      "a 403 for a suspended installation",
      httpError(403, "This installation has been suspended", {
        "x-ratelimit-remaining": "4999",
      }),
      "GITHUB_INSTALLATION_UNAVAILABLE",
    ],
    [
      "a 403 rate limit",
      httpError(403, "API rate limit exceeded", {
        "x-ratelimit-remaining": "0",
      }),
      "GITHUB_RATE_LIMITED",
    ],
    ["a 429", httpError(429, "Too many requests"), "GITHUB_RATE_LIMITED"],
    ["a 401", httpError(401, "Bad credentials"), "GITHUB_AUTH_FAILED"],
    ["a 502", httpError(502, "Bad Gateway"), "GITHUB_UNKNOWN_ERROR"],
    ["a network error", new Error("ECONNRESET"), "GITHUB_UNKNOWN_ERROR"],
  ])("classifies %s", async (_label, error, expected) => {
    octokitMocks.createInstallationAccessToken.mockRejectedValue(error);
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).fetchPullRequestDiff(
      "owner",
      "repo",
      42,
    );

    expect(result).toEqual({ success: false, error: expected });
    expect(octokitMocks.getPullRequest).not.toHaveBeenCalled();
  });
});

describe("fetchPullRequestHeadSha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokitMocks.createInstallationAccessToken.mockResolvedValue({
      data: { token: "installation-token" },
    });
    octokitMocks.rateLimitGet.mockResolvedValue({
      data: { resources: { core: { remaining: 5000, reset: 0 } } },
    });
  });

  it("returns the SHA of the pull request's head commit", async () => {
    octokitMocks.getPullRequest.mockResolvedValue({
      data: { head: { sha: "head-sha" } },
    });
    const { createGitHubServiceFromEnv } = await loadFreshApiModule();

    const result = await createGitHubServiceFromEnv(1).fetchPullRequestHeadSha(
      "owner",
      "repo",
      42,
    );

    expect(result).toEqual({ success: true, data: "head-sha" });
    expect(octokitMocks.getPullRequest).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 42,
    });
  });
});
