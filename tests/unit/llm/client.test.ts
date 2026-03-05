import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReviewChunk,
  createReviewFinding,
} from "../../helpers/factories";

// Mock the SDK
const mockCreate = vi.fn();

class MockRateLimitError extends Error {
  constructor() {
    super("Rate limited");
    this.name = "RateLimitError";
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

vi.mock("@anthropic-ai/sdk", () => {
  class MockSdk {
    messages = { create: mockCreate };
    static RateLimitError = MockRateLimitError;
    static APIConnectionTimeoutError = MockAPIConnectionTimeoutError;
    static BadRequestError = MockBadRequestError;
    static InternalServerError = MockInternalServerError;
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
  parseLlmReviewResponse: vi.fn().mockReturnValue({
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

  it("returns LLM_API_KEY_MISSING when API key is empty", async () => {
    const service = createLlmClient({ apiKey: "" });
    const result = await service.analyzeReviewChunk(createReviewChunk());
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
    await service.analyzeReviewChunk(createReviewChunk());

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        system: "You are a code reviewer.",
        messages: [{ role: "user", content: "Review this code." }],
      }),
    );
  });

  it("returns findings and token usage on success", async () => {
    mockSuccessfulResponse();
    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(createReviewChunk());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.findings).toHaveLength(1);
    expect(result.data.tokenUsage.inputTokens).toBe(100);
    expect(result.data.tokenUsage.outputTokens).toBe(50);
  });

  it("returns LLM_INVALID_RESPONSE when SDK returns no text block", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "123" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const service = createLlmClient({ apiKey: "test-key", maxRetries: 0 });
    const result = await service.analyzeReviewChunk(createReviewChunk());

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
    const resultPromise = service.analyzeReviewChunk(createReviewChunk());

    // Advance past retry delay (1s for first retry)
    await vi.advanceTimersByTimeAsync(1500);

    const result = await resultPromise;
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);

    vi.useRealTimers();
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
    const resultPromise = service.analyzeReviewChunk(createReviewChunk());

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
    const result = await service.analyzeReviewChunk(createReviewChunk());

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
    const resultPromise = service.analyzeReviewChunk(createReviewChunk());

    // Advance past retry delays
    await vi.advanceTimersByTimeAsync(5000);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LLM_RATE_LIMITED");

    vi.useRealTimers();
  });

  it("builds 'No issues found' summary for zero findings", async () => {
    mockSuccessfulResponse();

    // Override parser mock to return empty findings
    const { parseLlmReviewResponse } = await import("@/lib/llm/parser");
    vi.mocked(parseLlmReviewResponse).mockReturnValueOnce({
      success: true,
      data: [],
    });

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(createReviewChunk());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary).toContain("No issues found");
  });

  it("builds summary with finding count", async () => {
    mockSuccessfulResponse();

    const service = createLlmClient({ apiKey: "test-key" });
    const result = await service.analyzeReviewChunk(createReviewChunk());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary).toContain("1 issue");
  });
});
