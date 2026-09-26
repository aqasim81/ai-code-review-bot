import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReviewChunk,
  createReviewFinding,
  createReviewPromptOptions,
} from "../../helpers/factories";

// Mock the SDK
const mockCreate = vi.fn();

// Like the SDK's APIError: the response headers and the parsed error body.
class MockRateLimitError extends Error {
  readonly headers: Headers;
  readonly error: unknown;
  constructor(headers: Record<string, string> = {}, body?: unknown) {
    super("Rate limited");
    this.name = "RateLimitError";
    this.headers = new Headers(headers);
    this.error = body;
  }
}

class MockAPIConnectionTimeoutError extends Error {
  constructor() {
    super("Timeout");
    this.name = "APIConnectionTimeoutError";
  }
}

class MockBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

class MockInternalServerError extends Error {
  constructor() {
    super("Internal server error");
    this.name = "InternalServerError";
  }
}

class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}
class MockNotFoundError extends Error {}
class MockUnprocessableEntityError extends Error {}

const sdkOptions: unknown[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  class MockSdk {
    constructor(options: unknown) {
      sdkOptions.push(options);
    }
    messages = { create: mockCreate };
    static RateLimitError = MockRateLimitError;
    static APIConnectionTimeoutError = MockAPIConnectionTimeoutError;
    static BadRequestError = MockBadRequestError;
    static InternalServerError = MockInternalServerError;
    static AuthenticationError = MockAuthenticationError;
    static PermissionDeniedError = MockPermissionDeniedError;
    static NotFoundError = MockNotFoundError;
    static UnprocessableEntityError = MockUnprocessableEntityError;
  }
  return { default: MockSdk };
});

vi.mock("@/lib/llm/prompts", () => ({
  buildReviewPrompt: vi.fn().mockReturnValue({
    system: "You are a code reviewer.",
    user: "Review this code.",
  }),
}));

vi.mock("@/lib/llm/parser", () => ({
  DEFAULT_CONFIDENCE_THRESHOLD: 0.7,
  parseLlmReviewResponse: vi.fn().mockReturnValue({
    success: true,
    data: [createReviewFinding()],
  }),
  parseTruncatedLlmReviewResponse: vi.fn().mockReturnValue({
    success: true,
    data: [createReviewFinding()],
  }),
}));

describe("createLlmClient", () => {
  let createLlmClient: typeof import("@/lib/llm/client").createLlmClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();

    // vi.resetModules() is required here: the vi.mock factory above references
    // module-level classes (MockRateLimitError etc.) which are in the temporal
    // dead zone during the initial hoisted evaluation. resetModules forces
    // re-evaluation after classes are initialized.
    vi.resetModules();
    const mod = await import("@/lib/llm/client");
    createLlmClient = mod.createLlmClient;
  });

  function mockSuccessfulResponse(text = "[]") {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  }

  it("returns LLMService object with analyzeReviewChunk method", () => {
    const service = createLlmClient({ apiKey: "test-key" });
    expect(service).toHaveProperty("analyzeReviewChunk");
    expect(typeof service.analyzeReviewChunk).toBe("function");
  });

  it("builds the prompt with the repository's prompt options", async () => {
    mockSuccessfulResponse();
    const { buildReviewPrompt } = await import("@/lib/llm/prompts");
    const service = createLlmClient({ apiKey: "test-key" });
    const chunk = createReviewChunk();
    const options = createReviewPromptOptions({
      customInstructions: "We use tabs.",
      enabledCategories: ["BUGS"],
    });

    await service.analyzeReviewChunk(chunk, options);

    expect(buildReviewPrompt).toHaveBeenCalledWith(chunk, options);
  });

  it("returns LLM_API_KEY_MISSING when API key is empty", async () => {
    const service = createLlmClient({ apiKey: "" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_API_KEY_MISSING");
  });

  it("calls SDK with correct model and messages", async () => {
    mockSuccessfulResponse();
    const service = createLlmClient({
      apiKey: "test-key",
      modelId: "test-model",
    });
    await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        system: "You are a code reviewer.",
        messages: [{ role: "user", content: "Review this code." }],
      }),
    );
  });

  it("sends the configured model when none is passed", async () => {
    mockSuccessfulResponse();
    const service = createLlmClient({ apiKey: "test-key" });
    await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "configured-model" }),
    );
  });

  it("leaves room for thinking in the output limit by default", async () => {
    mockSuccessfulResponse();
    const service = createLlmClient({ apiKey: "test-key" });
    await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 16_000 }),
    );
  });

  it("returns findings and token usage on success", async () => {
    mockSuccessfulResponse();
    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.findings).toHaveLength(1);
    expect(result.data.tokenUsage.inputTokens).toBe(100);
    expect(result.data.tokenUsage.outputTokens).toBe(50);
  });

  it("keeps the complete findings of a reply cut off at the output limit", async () => {
    const parser = await import("@/lib/llm/parser");
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '[{"filePath": "src/a.ts"' }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 4096 },
    });

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ truncated: true }),
    });
    expect(parser.parseTruncatedLlmReviewResponse).toHaveBeenCalledWith(
      '[{"filePath": "src/a.ts"',
      0.7,
    );
    expect(parser.parseLlmReviewResponse).not.toHaveBeenCalled();
  });

  it("parses a reply that ended normally with the strict parser", async () => {
    const parser = await import("@/lib/llm/parser");
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 5 },
    });

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ truncated: false }),
    });
    expect(parser.parseLlmReviewResponse).toHaveBeenCalledWith("[]", 0.7);
    expect(parser.parseTruncatedLlmReviewResponse).not.toHaveBeenCalled();
  });

  // The model thinks by default and thinking counts toward max_tokens, so a
  // reply can stop at the limit with thinking and no text (#120).
  it("reports the output limit, not bad output, when thinking used the whole limit (#120)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "thinking", thinking: "Let me look...", signature: "" },
      ],
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 16_000 },
    });

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result).toEqual({
      success: false,
      error: "LLM_OUTPUT_LIMIT_REACHED",
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("reports the output limit when a cut-off reply has no complete finding (#120)", async () => {
    const parser = await import("@/lib/llm/parser");
    vi.mocked(parser.parseTruncatedLlmReviewResponse).mockReturnValueOnce({
      success: false,
      error: "LLM_INVALID_RESPONSE",
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '[{"filePath": "src/a.ts"' }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 16_000 },
    });

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result).toEqual({
      success: false,
      error: "LLM_OUTPUT_LIMIT_REACHED",
    });
  });

  it("reports a refusal without parsing its partial text or retrying (#120)", async () => {
    const parser = await import("@/lib/llm/parser");
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
      stop_reason: "refusal",
      usage: { input_tokens: 100, output_tokens: 3 },
    });

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result).toEqual({ success: false, error: "LLM_REFUSED" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(parser.parseLlmReviewResponse).not.toHaveBeenCalled();
    expect(parser.parseTruncatedLlmReviewResponse).not.toHaveBeenCalled();
  });

  it("reports a refusal that came with no text (#120)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [],
      stop_reason: "refusal",
      usage: { input_tokens: 100, output_tokens: 0 },
    });

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result).toEqual({ success: false, error: "LLM_REFUSED" });
  });

  it("turns off the SDK's own retries so a chunk is retried only here", async () => {
    mockSuccessfulResponse();
    const service = createLlmClient({ apiKey: "test-key" });
    await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(sdkOptions.at(-1)).toEqual(
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it.each([
    [
      "an invalid API key",
      new MockAuthenticationError("401"),
      "LLM_AUTH_FAILED",
    ],
    [
      "a denied permission",
      new MockPermissionDeniedError("403"),
      "LLM_AUTH_FAILED",
    ],
    ["an unknown model", new MockNotFoundError("404"), "LLM_BAD_REQUEST"],
    [
      "an unprocessable request",
      new MockUnprocessableEntityError("422"),
      "LLM_BAD_REQUEST",
    ],
    [
      "another bad request",
      new MockBadRequestError("messages: invalid"),
      "LLM_BAD_REQUEST",
    ],
  ])("does not retry %s", async (_label, error, expected) => {
    mockCreate.mockRejectedValueOnce(error);
    const service = createLlmClient({ apiKey: "test-key" });

    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result).toEqual({ success: false, error: expected });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns LLM_INVALID_RESPONSE when SDK returns no text block", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "123" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const service = createLlmClient({ apiKey: "test-key", maxRetries: 0 });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_INVALID_RESPONSE");
  });

  it("retries on rate limit error", async () => {
    vi.useFakeTimers();

    mockCreate
      .mockRejectedValueOnce(new MockRateLimitError())
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

    const service = createLlmClient({ apiKey: "test-key", maxRetries: 1 });
    const resultPromise = service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    // Advance past retry delay (1s for first retry)
    await vi.advanceTimersByTimeAsync(1500);

    const result = await resultPromise;
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);

    vi.useRealTimers();
  });

  describe("on a rate limit", () => {
    function rateLimitedThenOk(error: MockRateLimitError) {
      mockCreate.mockRejectedValueOnce(error).mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });
    }

    function analyze(maxRetries = 3) {
      const service = createLlmClient({ apiKey: "test-key", maxRetries });
      return service.analyzeReviewChunk(
        createReviewChunk(),
        createReviewPromptOptions(),
      );
    }

    it("waits the seconds the retry-after header asks for", async () => {
      vi.useFakeTimers();
      rateLimitedThenOk(new MockRateLimitError({ "retry-after": "45" }));

      const resultPromise = analyze();

      await vi.advanceTimersByTimeAsync(44_000);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect((await resultPromise).success).toBe(true);
    });

    it("prefers the retry-after-ms header", async () => {
      vi.useFakeTimers();
      rateLimitedThenOk(
        new MockRateLimitError({
          "retry-after-ms": "2500",
          "retry-after": "3",
        }),
      );

      const resultPromise = analyze();

      await vi.advanceTimersByTimeAsync(2_400);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect((await resultPromise).success).toBe(true);
    });

    it("reads a retry-after header given as a date", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      rateLimitedThenOk(
        new MockRateLimitError({
          "retry-after": "Thu, 01 Jan 2026 00:00:20 GMT",
        }),
      );

      const resultPromise = analyze();

      await vi.advanceTimersByTimeAsync(19_000);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect((await resultPromise).success).toBe(true);
    });

    it.each([
      ["a retry-after of zero", { "retry-after": "0" }],
      ["a retry-after-ms of zero", { "retry-after-ms": "0" }],
      ["a negative retry-after", { "retry-after": "-5" }],
      [
        "a retry-after date already past",
        { "retry-after": "Wed, 31 Dec 2025 23:59:58 GMT" },
      ],
    ])("keeps the short backoff for %s", async (_label, headers) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      rateLimitedThenOk(new MockRateLimitError(headers));

      const resultPromise = analyze();

      await vi.advanceTimersByTimeAsync(999);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect((await resultPromise).success).toBe(true);
    });

    it("reads retry-after when retry-after-ms is zero", async () => {
      vi.useFakeTimers();
      rateLimitedThenOk(
        new MockRateLimitError({ "retry-after-ms": "0", "retry-after": "5" }),
      );

      const resultPromise = analyze();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect((await resultPromise).success).toBe(true);
    });

    it("keeps the short backoff when there is no retry-after header", async () => {
      vi.useFakeTimers();
      rateLimitedThenOk(new MockRateLimitError());

      const resultPromise = analyze();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect((await resultPromise).success).toBe(true);
    });

    it("leaves a wait longer than a minute to the job's backoff", async () => {
      mockCreate.mockRejectedValue(
        new MockRateLimitError({ "retry-after": "600" }),
      );

      const result = await analyze();

      expect(result).toEqual({ success: false, error: "LLM_RATE_LIMITED" });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("does not retry once the monthly spend cap is reached", async () => {
      mockCreate.mockRejectedValue(
        new MockRateLimitError(
          {},
          {
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "You have reached your API usage limits.",
              details: { error_code: "enforced_spend_limit_reached" },
            },
          },
        ),
      );

      const result = await analyze();

      expect(result).toEqual({
        success: false,
        error: "LLM_SPEND_LIMIT_REACHED",
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the short backoff for a server error that asks for a long wait", async () => {
    vi.useFakeTimers();
    const overloaded = Object.assign(new MockInternalServerError(), {
      headers: new Headers({ "retry-after": "600" }),
    });
    mockCreate.mockRejectedValueOnce(overloaded).mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const service = createLlmClient({ apiKey: "test-key", maxRetries: 1 });
    const resultPromise = service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect((await resultPromise).success).toBe(true);
  });

  it("retries on timeout error", async () => {
    vi.useFakeTimers();

    mockCreate
      .mockRejectedValueOnce(new MockAPIConnectionTimeoutError())
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

    const service = createLlmClient({ apiKey: "test-key", maxRetries: 1 });
    const resultPromise = service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    await vi.advanceTimersByTimeAsync(1500);

    const result = await resultPromise;
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);

    vi.useRealTimers();
  });

  it("does not retry on non-retryable errors (context too long)", async () => {
    mockCreate.mockRejectedValueOnce(
      new MockBadRequestError("context length exceeded"),
    );

    const service = createLlmClient({ apiKey: "test-key", maxRetries: 3 });
    const result = await service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_CONTEXT_TOO_LONG");
  });

  it("returns last error after all retries exhausted", async () => {
    vi.useFakeTimers();

    mockCreate
      .mockRejectedValueOnce(new MockRateLimitError())
      .mockRejectedValueOnce(new MockRateLimitError());

    const service = createLlmClient({ apiKey: "test-key", maxRetries: 1 });
    const resultPromise = service.analyzeReviewChunk(
      createReviewChunk(),
      createReviewPromptOptions(),
    );

    // Advance past retry delays
    await vi.advanceTimersByTimeAsync(5000);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_RATE_LIMITED");

    vi.useRealTimers();
  });
});
