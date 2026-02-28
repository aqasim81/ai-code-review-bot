import LlmSdk from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { parseLlmReviewResponse } from "@/lib/llm/parser";
import { buildReviewPrompt } from "@/lib/llm/prompts";
import { logger } from "@/lib/logger";
import type { LLMError, LLMService } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type { ReviewChunk, ReviewResult } from "@/types/review";

const DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const BASE_RETRY_DELAY_MS = 1000;

interface LlmClientOptions {
  readonly apiKey?: string;
  readonly modelId?: string;
  readonly maxRetries?: number;
  readonly confidenceThreshold?: number;
  readonly maxOutputTokens?: number;
}

export function createLlmClient(options?: LlmClientOptions): LLMService {
  const apiKey = options?.apiKey ?? env.ANTHROPIC_API_KEY;
  const modelId = options?.modelId ?? DEFAULT_MODEL_ID;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const confidenceThreshold =
    options?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxOutputTokens = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  let sdkClient: LlmSdk | null = null;

  return {
    async analyzeReviewChunk(
      chunk: ReviewChunk,
    ): Promise<Result<ReviewResult, LLMError>> {
      if (apiKey === undefined || apiKey.length === 0) {
        return err("LLM_API_KEY_MISSING");
      }

      if (sdkClient === null) {
        sdkClient = new LlmSdk({ apiKey });
      }

      const prompt = buildReviewPrompt(chunk);

      const result = await callWithRetry(
        sdkClient,
        modelId,
        maxOutputTokens,
        prompt.system,
        prompt.user,
        maxRetries,
      );

      if (!result.success) {
        return result;
      }

      const { responseText, inputTokens, outputTokens } = result.data;

      const parseResult = parseLlmReviewResponse(
        responseText,
        confidenceThreshold,
      );
      if (!parseResult.success) {
        return parseResult;
      }

      const summary = buildSummary(parseResult.data.length);

      return ok({
        findings: parseResult.data,
        summary,
        tokenUsage: { inputTokens, outputTokens },
      });
    },
  };
}

interface LlmRawResponse {
  readonly responseText: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

async function callWithRetry(
  client: LlmSdk,
  modelId: string,
  maxOutputTokens: number,
  system: string,
  userMessage: string,
  maxRetries: number,
): Promise<Result<LlmRawResponse, LLMError>> {
  let lastError: LLMError = "LLM_UNKNOWN_ERROR";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = BASE_RETRY_DELAY_MS * 3 ** (attempt - 1);
      logger.info("Retrying LLM call", { attempt, delayMs });
      await sleep(delayMs);
    }

    try {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: maxOutputTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      });

      const textBlock = response.content.find((block) => block.type === "text");
      if (textBlock === undefined || textBlock.type !== "text") {
        lastError = "LLM_INVALID_RESPONSE";
        continue;
      }

      logger.info("LLM call completed", {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: modelId,
      });

      return ok({
        responseText: textBlock.text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });
    } catch (error: unknown) {
      const mappedError = mapSdkError(error);
      lastError = mappedError;

      if (!isRetryableError(mappedError)) {
        return err(mappedError);
      }

      logger.warn("LLM call failed, will retry", {
        attempt,
        error: mappedError,
      });
    }
  }

  return err(lastError);
}

function mapSdkError(error: unknown): LLMError {
  if (error instanceof LlmSdk.RateLimitError) {
    return "LLM_RATE_LIMITED";
  }
  if (error instanceof LlmSdk.APIConnectionTimeoutError) {
    return "LLM_TIMEOUT";
  }
  if (error instanceof LlmSdk.BadRequestError) {
    const message = error.message ?? "";
    if (
      message.includes("context length") ||
      message.includes("too many tokens") ||
      message.includes("maximum")
    ) {
      return "LLM_CONTEXT_TOO_LONG";
    }
    return "LLM_UNKNOWN_ERROR";
  }
  if (error instanceof LlmSdk.InternalServerError) {
    return "LLM_UNKNOWN_ERROR";
  }
  return "LLM_UNKNOWN_ERROR";
}

function isRetryableError(error: LLMError): boolean {
  return (
    error === "LLM_RATE_LIMITED" ||
    error === "LLM_TIMEOUT" ||
    error === "LLM_UNKNOWN_ERROR"
  );
}

function buildSummary(findingCount: number): string {
  if (findingCount === 0) {
    return "No issues found in this review.";
  }
  return `Found ${findingCount} issue${findingCount === 1 ? "" : "s"} in this review.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
