import { beforeEach, describe, expect, it, vi } from "vitest";

const octokitMocks = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  createInstallationAccessToken: vi.fn(),
  rateLimitGet: vi.fn(),
  paginate: vi.fn(),
  listReviews: vi.fn(),
  getContent: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    apps = {
      getAuthenticated: octokitMocks.getAuthenticated,
      createInstallationAccessToken: octokitMocks.createInstallationAccessToken,
    };
    rateLimit = { get: octokitMocks.rateLimitGet };
    pulls = { listReviews: octokitMocks.listReviews };
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
