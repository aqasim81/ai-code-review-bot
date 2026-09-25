import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(), getSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/db/queries");

import { toggleRepositoryEnabledAction } from "@/app/dashboard/actions";
import DashboardPage from "@/app/dashboard/page";
import RepoSettingsPage from "@/app/dashboard/repos/[id]/page";
import RepositoriesPage from "@/app/dashboard/repos/page";
import ReviewDetailPage from "@/app/dashboard/reviews/[id]/page";
import ReviewsPage from "@/app/dashboard/reviews/page";
import { auth, getSession } from "@/auth";
import {
  findAccessibleRepositoryById,
  findInstallationsByGitHubIds,
  getReviewStatsInScope,
  getReviewWithCommentsInScope,
  listRepositoriesInScope,
  listReviewsInScope,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import type { InstallationId } from "@/types/branded";
import { err, ok } from "@/types/results";

const REPO_ID = "5f0c6a3e-8b8e-4f7c-9a52-2f6d6f1d2a11";
const DB_DOWN = "Failed to run query: Can't reach database server at db:5432";

const SESSION = {
  user: { id: "u1", githubId: 1, login: "dev", avatarUrl: "" },
  access: {
    githubInstallationIds: [10],
    accessibleGithubRepoIds: [1],
    manageableGithubRepoIds: [1],
    truncated: false,
  },
  expires: "2099-01-01T00:00:00.000Z",
};

const INSTALLATION = {
  id: "inst-1" as InstallationId,
  githubInstallationId: 10,
  githubAccountLogin: "acme",
  githubAccountType: "ORG",
  status: "ACTIVE",
} as const;

// auth() is overloaded (session getter and middleware wrapper); tests only use
// the session getter.
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn>;
const mockedGetSession = getSession as unknown as ReturnType<typeof vi.fn>;

function allQueriesSucceedWithNoRows(): void {
  vi.mocked(findInstallationsByGitHubIds).mockResolvedValue(ok([INSTALLATION]));
  vi.mocked(getReviewStatsInScope).mockResolvedValue(
    ok({
      totalReviews: 0,
      totalIssuesFound: 0,
      recentReviewCount: 0,
      categoryBreakdown: [],
    }),
  );
  vi.mocked(listRepositoriesInScope).mockResolvedValue(ok([]));
  vi.mocked(listReviewsInScope).mockResolvedValue(
    ok({ reviews: [], nextCursor: null }),
  );
  vi.mocked(findAccessibleRepositoryById).mockResolvedValue(ok(null));
  vi.mocked(getReviewWithCommentsInScope).mockResolvedValue(ok(null));
}

async function renderPage(page: Promise<ReactElement>): Promise<string> {
  return renderToStaticMarkup(await page);
}

const renderDashboard = () => renderPage(DashboardPage());
const renderReviews = () =>
  renderPage(ReviewsPage({ searchParams: Promise.resolve({}) }));
const renderRepositories = () => renderPage(RepositoriesPage());
const renderRepoSettings = () =>
  renderPage(RepoSettingsPage({ params: Promise.resolve({ id: REPO_ID }) }));
const renderReviewDetail = () =>
  renderPage(ReviewDetailPage({ params: Promise.resolve({ id: REPO_ID }) }));

const MISLEADING_ANSWERS = [
  "No installations found",
  "No repositories found",
  "No reviews",
];

function expectLoadFailureShown(html: string): void {
  expect(html).toContain("Could not load");
  for (const answer of MISLEADING_ANSWERS) {
    expect(html).not.toContain(answer);
  }
  expect(logger.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ error: DB_DOWN }),
  );
}

describe("dashboard pages when a database query fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSession.mockResolvedValue(SESSION);
    mockedAuth.mockResolvedValue(SESSION);
    allQueriesSucceedWithNoRows();
  });

  it.each([
    [
      "dashboard",
      "installations",
      findInstallationsByGitHubIds,
      renderDashboard,
    ],
    ["dashboard", "stats", getReviewStatsInScope, renderDashboard],
    ["dashboard", "repositories", listRepositoriesInScope, renderDashboard],
    ["reviews", "installations", findInstallationsByGitHubIds, renderReviews],
    ["reviews", "repositories", listRepositoriesInScope, renderReviews],
    ["reviews", "reviews", listReviewsInScope, renderReviews],
    [
      "repositories",
      "installations",
      findInstallationsByGitHubIds,
      renderRepositories,
    ],
    [
      "repositories",
      "repositories",
      listRepositoriesInScope,
      renderRepositories,
    ],
  ] as const)(
    "the %s page reports a failed %s query instead of an empty answer",
    async (_page, _query, query, render) => {
      vi.mocked(query).mockResolvedValue(err(DB_DOWN));

      const html = await render();

      expectLoadFailureShown(html);
    },
  );

  it.each([
    ["repository settings", findAccessibleRepositoryById, renderRepoSettings],
    ["review detail", getReviewWithCommentsInScope, renderReviewDetail],
  ] as const)(
    "the %s page reports a failed lookup instead of a 404",
    async (_page, query, render) => {
      vi.mocked(query).mockResolvedValue(err(DB_DOWN));

      const html = await render();

      expectLoadFailureShown(html);
    },
  );

  it.each([
    ["repository settings", renderRepoSettings],
    ["review detail", renderReviewDetail],
  ] as const)(
    "the %s page still answers 404 when nothing matches",
    async (_page, render) => {
      await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    },
  );

  it.each([
    ["dashboard", renderDashboard],
    ["reviews", renderReviews],
  ] as const)(
    "the %s page still shows the install prompt when the user has no installations",
    async (_page, render) => {
      vi.mocked(findInstallationsByGitHubIds).mockResolvedValue(ok([]));

      const html = await render();

      expect(html).toContain("No installations found");
      expect(html).not.toContain("Could not load");
      expect(logger.error).not.toHaveBeenCalled();
    },
  );
});

// At sign-in, or in the refresh right after installing the app, a GitHub
// error leaves the session without the new access. That is not an answer
// that the user has no installations (#118).
describe("dashboard pages while loading the user's GitHub access has failed", () => {
  const PENDING_SESSION = {
    ...SESSION,
    access: {
      githubInstallationIds: [],
      accessibleGithubRepoIds: [],
      manageableGithubRepoIds: [],
      truncated: false,
    },
    accessPending: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSession.mockResolvedValue(PENDING_SESSION);
    allQueriesSucceedWithNoRows();
    vi.mocked(findInstallationsByGitHubIds).mockResolvedValue(ok([]));
  });

  it.each([
    ["dashboard", renderDashboard],
    ["reviews", renderReviews],
    ["repositories", renderRepositories],
  ] as const)(
    "the %s page says the access could not be loaded, not that there are no installations",
    async (_page, render) => {
      const html = await render();

      expect(html).toContain("Could not load your GitHub installations");
      expect(html).not.toContain("No installations found");
    },
  );
});

// Ids are UUIDs. A malformed one from the URL (NUL, which Postgres rejects in
// text, or any other non-UUID) can never match, so it must not reach a query
// and be reported as a load failure that a retry could fix.
const MALFORMED_IDS = ["\u0000", "abc\u0000def", "not-a-uuid"];

describe("dashboard pages with malformed ids in the URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSession.mockResolvedValue(SESSION);
    allQueriesSucceedWithNoRows();
  });

  it.each(MALFORMED_IDS)(
    "the repository settings page answers 404 for id %j without querying",
    async (id) => {
      await expect(
        renderPage(RepoSettingsPage({ params: Promise.resolve({ id }) })),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(findAccessibleRepositoryById).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_IDS)(
    "the review detail page answers 404 for id %j without querying",
    async (id) => {
      await expect(
        renderPage(ReviewDetailPage({ params: Promise.resolve({ id }) })),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(getReviewWithCommentsInScope).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it.each(
    MALFORMED_IDS.flatMap((value) => [
      ["repo", value],
      ["cursor", value],
    ]),
  )(
    "the reviews page ignores a malformed %s filter %j",
    async (param, value) => {
      const html = await renderPage(
        ReviewsPage({ searchParams: Promise.resolve({ [param]: value }) }),
      );

      expect(html).not.toContain("Could not load");
      expect(logger.error).not.toHaveBeenCalled();
      expect(listReviewsInScope).toHaveBeenCalledWith(
        expect.objectContaining({ repositoryId: undefined, cursor: undefined }),
      );
    },
  );

  it("the reviews page passes valid repo and cursor ids to the query", async () => {
    await renderPage(
      ReviewsPage({
        searchParams: Promise.resolve({ repo: REPO_ID, cursor: REPO_ID }),
      }),
    );

    expect(listReviewsInScope).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: REPO_ID, cursor: REPO_ID }),
    );
  });
});

describe("dashboard repository actions when the lookup fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue(SESSION);
  });

  it("reports a retryable save failure instead of unauthorized", async () => {
    vi.mocked(findAccessibleRepositoryById).mockResolvedValue(err(DB_DOWN));

    const result = await toggleRepositoryEnabledAction(REPO_ID, true);

    expect(result).toEqual({
      success: false,
      error: "Could not save the change. Please try again.",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: DB_DOWN }),
    );
  });
});
