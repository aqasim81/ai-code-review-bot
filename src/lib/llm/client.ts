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
import type { LLMError, LLMService, ReviewPromptOptions } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type { ReviewChunk, ReviewResult } from "@/types/review";

const DEFAULT_MAX_RETRIES = 3;
// The model thinks by default and its thinking counts toward this limit, so it
// leaves room for thinking plus the JSON reply while staying under the SDK's
// limit for requests that are not streamed.
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const BASE_RETRY_DELAY_MS = 1000;
// The SDK's own retry follows retry-after only up to a minute (retryRequest in
// the SDK's client.js). A longer wait is left to the job's rate-limit backoff
// rather than holding the worker.
const MAX_RETRY_AFTER_MS = 60_000;

interface LlmClientOptions {
  readonly apiKey?: string;
  readonly modelId?: string;
  readonly maxRetries?: number;
  readonly confidenceThreshold?: number;
  readonly maxOutputTokens?: number;
}

export function createLlmClient(options?: LlmClientOptions): LLMService {
  const apiKey = options?.apiKey ?? env.ANTHROPIC_API_KEY;
  const modelId = options?.modelId ?? env.LLM_MODEL_ID;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const confidenceThreshold =
    options?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxOutputTokens = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  let sdkClient: LlmSdk | null = null;

  return {
    async analyzeReviewChunk(
      chunk: ReviewChunk,
      promptOptions: ReviewPromptOptions,
    ): Promise<Result<ReviewResult, LLMError>> {
      if (apiKey === undefined || apiKey.length === 0) {
        return err("LLM_API_KEY_MISSING");
      }

      if (sdkClient === null) {
        // Retries happen in callWithRetry only, so SDK retries would multiply them.
        sdkClient = new LlmSdk({ apiKey, maxRetries: 0 });
      }

      const prompt = buildReviewPrompt(chunk, promptOptions);

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
        truncated,
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

interface LlmCallFailure {
  readonly error: LLMError;
  /** How long the API asked to wait before a retry, when it said. */
  readonly retryAfterMs: number | null;
}

function canRetryLlmCall(failure: LlmCallFailure): boolean {
  if (!isRetryableError(failure.error)) return false;
  return (
    failure.retryAfterMs === null || failure.retryAfterMs <= MAX_RETRY_AFTER_MS
  );
}

async function callWithRetry(
  client: LlmSdk,
  modelId: string,
  maxOutputTokens: number,
  system: string,
  userMessage: string,
  maxRetries: number,
): Promise<Result<LlmRawResponse, LLMError>> {
  let lastFailure: LlmCallFailure = {
    error: "LLM_UNKNOWN_ERROR",
    retryAfterMs: null,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Retrying before retry-after has passed fails again (rate-limit docs).
      const delayMs =
        lastFailure.retryAfterMs ??
        exponentialDelayMs(BASE_RETRY_DELAY_MS, 3, attempt);
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

    lastFailure = result.error;
    if (!canRetryLlmCall(lastFailure)) {
      return err(lastFailure.error);
    }

    logger.warn("LLM call failed, will retry", {
      attempt,
      error: lastFailure.error,
      retryAfterMs: lastFailure.retryAfterMs,
    });
  }

  return err(lastFailure.error);
}

async function executeSingleLlmCall(
  client: LlmSdk,
  modelId: string,
  maxOutputTokens: number,
  system: string,
  userMessage: string,
): Promise<Result<LlmRawResponse, LlmCallFailure>> {
  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: maxOutputTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (textBlock === undefined || textBlock.type !== "text") {
      return err({ error: "LLM_INVALID_RESPONSE", retryAfterMs: null });
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
    return err({
      error: mapSdkError(error),
      retryAfterMs: readRetryAfterMs(error),
    });
  }
}

function readResponseHeader(error: unknown, name: string): string | null {
  if (typeof error !== "object" || error === null) return null;
  const headers = (error as { headers?: unknown }).headers;
  return headers instanceof Headers ? headers.get(name) : null;
}

/**
 * Reads how long the API asked to wait, as the SDK's own retry does:
 * retry-after-ms first, then retry-after in seconds or as an HTTP date.
 */
function readRetryAfterMs(error: unknown): number | null {
  const millis = Number.parseFloat(
    readResponseHeader(error, "retry-after-ms") ?? "",
  );
  if (!Number.isNaN(millis)) return Math.max(0, millis);

  const retryAfter = readResponseHeader(error, "retry-after");
  if (retryAfter === null) return null;
  const seconds = Number.parseFloat(retryAfter);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * A 429 also answers a request past the organisation's monthly spend cap. It
 * has no retry-after and every retry fails until the cap is raised or the
 * month ends; the error body names it (rate-limit docs, "Reaching your spend
 * cap"). The SDK keeps the parsed body on the error.
 */
function isSpendLimitReached(
  error: InstanceType<typeof LlmSdk.RateLimitError>,
): boolean {
  const body: unknown = error.error;
  if (typeof body !== "object" || body === null) return false;
  const inner: unknown = (body as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return false;
  const details: unknown = (inner as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return false;
  return (
    (details as { error_code?: unknown }).error_code ===
    "enforced_spend_limit_reached"
  );
}

function mapSdkError(error: unknown): LLMError {
  if (error instanceof LlmSdk.RateLimitError) {
    return isSpendLimitReached(error)
      ? "LLM_SPEND_LIMIT_REACHED"
      : "LLM_RATE_LIMITED";
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
