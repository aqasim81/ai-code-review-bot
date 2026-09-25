import LlmSdk from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  parseLlmReviewResponse,
  parseTruncatedLlmReviewResponse,
} from "@/lib/llm/parser";
import { buildReviewPrompt } from "@/lib/llm/prompts";
import { logger } from "@/lib/logger";
import { exponentialDelayMs, sleep } from "@/lib/retry";
import type { LLMError, LLMService } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type { ReviewChunk, ReviewResult } from "@/types/review";

const DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";
const DEFAULT_MAX_RETRIES = 3;
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
        // Retries happen in callWithRetry only, so SDK retries would multiply them.
        sdkClient = new LlmSdk({ apiKey, maxRetries: 0 });
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

      const { responseText, inputTokens, outputTokens, truncated } =
        result.data;

      // A reply cut off at the output limit is an incomplete JSON array; keep
      // the findings completed before the cut rather than failing the review.
      if (truncated) {
        logger.warn("LLM output truncated at the output token limit", {
          filePaths: chunk.files.map((file) => file.filePath),
          outputTokens,
          maxOutputTokens,
        });
      }
      const parseResult = truncated
        ? parseTruncatedLlmReviewResponse(responseText, confidenceThreshold)
        : parseLlmReviewResponse(responseText, confidenceThreshold);
      if (!parseResult.success) {
        return parseResult;
      }

      return ok({
        findings: parseResult.data,
        tokenUsage: { inputTokens, outputTokens },
      });
    },
  };
}

interface LlmRawResponse {
  readonly responseText: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly truncated: boolean;
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
      const delayMs = exponentialDelayMs(BASE_RETRY_DELAY_MS, 3, attempt);
      logger.info("Retrying LLM call", { attempt, delayMs });
      await sleep(delayMs);
    }

    const result = await executeSingleLlmCall(
      client,
      modelId,
      maxOutputTokens,
      system,
      userMessage,
    );

    if (result.success) {
      return result;
    }

    lastError = result.error;
    if (!isRetryableError(lastError)) {
      return result;
    }

    logger.warn("LLM call failed, will retry", {
      attempt,
      error: lastError,
    });
  }

  return err(lastError);
}

async function executeSingleLlmCall(
  client: LlmSdk,
  modelId: string,
  maxOutputTokens: number,
  system: string,
  userMessage: string,
): Promise<Result<LlmRawResponse, LLMError>> {
  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: maxOutputTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (textBlock === undefined || textBlock.type !== "text") {
      return err("LLM_INVALID_RESPONSE");
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
      truncated: response.stop_reason === "max_tokens",
    });
  } catch (error: unknown) {
    return err(mapSdkError(error));
  }
}

function mapSdkError(error: unknown): LLMError {
  if (error instanceof LlmSdk.RateLimitError) {
    return "LLM_RATE_LIMITED";
  }
  if (error instanceof LlmSdk.APIConnectionTimeoutError) {
    return "LLM_TIMEOUT";
  }
  if (
    error instanceof LlmSdk.AuthenticationError ||
    error instanceof LlmSdk.PermissionDeniedError
  ) {
    return "LLM_AUTH_FAILED";
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
    return "LLM_BAD_REQUEST";
  }
  if (
    error instanceof LlmSdk.NotFoundError ||
    error instanceof LlmSdk.UnprocessableEntityError
  ) {
    return "LLM_BAD_REQUEST";
  }
  // Server errors, overload and dropped connections can pass on a retry.
  return "LLM_UNKNOWN_ERROR";
}

function isRetryableError(error: LLMError): boolean {
  return (
    error === "LLM_RATE_LIMITED" ||
    error === "LLM_TIMEOUT" ||
    error === "LLM_UNKNOWN_ERROR"
  );
}
