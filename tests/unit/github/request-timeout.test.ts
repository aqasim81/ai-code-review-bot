import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubServiceFromEnv } from "@/lib/github/api";
import { fetchUserRepositoryAccess } from "@/lib/github/user-installations";

// Real Octokit and real fetch against a local server that stops answering, so
// the test shows how Octokit behaves when a request hangs, not what a mock says.

vi.mock("node:crypto", () => ({
  createSign: () => ({ update: vi.fn(), sign: () => "signature" }),
}));

const SHORT_TIMEOUT_MS = 200;
const TEST_TIMEOUT_MS = 5_000;

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;

async function startGitHub(handler: Handler): Promise<void> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
    realFetch(
      String(input).replace(
        "https://api.github.com",
        `http://127.0.0.1:${port}`,
      ),
      init,
    ),
  );
}

function neverAnswer(): void {}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

// Answers the token and rate-limit requests, then sends the diff's headers and
// the start of its body and stops.
const stallDuringDiffBody: Handler = (request, response) => {
  if (request.url?.includes("/access_tokens")) {
    sendJson(response, 201, { token: "installation-token" });
    return;
  }
  if (request.url?.startsWith("/rate_limit")) {
    sendJson(response, 200, {
      resources: { core: { remaining: 5000, reset: 0 } },
    });
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.write("diff --git a/src/index.ts b/src/index.ts\n");
};

beforeEach(() => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
    realTimeout(SHORT_TIMEOUT_MS),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("GitHub requests that never finish", () => {
  it(
    "fails a review's GitHub call as retryable when GitHub never answers",
    async () => {
      await startGitHub(neverAnswer);

      const result = await createGitHubServiceFromEnv(1).fetchPullRequestDiff(
        "owner",
        "repo",
        1,
      );

      expect(result).toEqual({ success: false, error: "GITHUB_UNKNOWN_ERROR" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails the call, rather than returning a cut-off diff, when the body stops arriving",
    async () => {
      await startGitHub(stallDuringDiffBody);

      const result = await createGitHubServiceFromEnv(1).fetchPullRequestDiff(
        "owner",
        "repo",
        1,
      );

      expect(result).toEqual({ success: false, error: "GITHUB_UNKNOWN_ERROR" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails the dashboard's repository access lookup when GitHub never answers",
    async () => {
      await startGitHub(neverAnswer);

      const result = await fetchUserRepositoryAccess("user-token");

      expect(result.success).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
