import type { CommentCategory } from "@/generated/prisma/enums";
import type { Result } from "@/types/results";
import type { ReviewChunk, ReviewResult } from "@/types/review";

export type LLMError =
  | "LLM_API_KEY_MISSING"
  | "LLM_AUTH_FAILED"
  | "LLM_BAD_REQUEST"
  | "LLM_RATE_LIMITED"
  | "LLM_SPEND_LIMIT_REACHED"
  | "LLM_TIMEOUT"
  | "LLM_INVALID_RESPONSE"
  | "LLM_OUTPUT_LIMIT_REACHED"
  | "LLM_REFUSED"
  | "LLM_CONTEXT_TOO_LONG"
  | "LLM_UNKNOWN_ERROR";

/** The repository's settings that shape the review prompt. */
export interface ReviewPromptOptions {
  readonly customInstructions: string;
  readonly enabledCategories: readonly CommentCategory[];
}

export interface LLMService {
  analyzeReviewChunk(
    chunk: ReviewChunk,
    promptOptions: ReviewPromptOptions,
  ): Promise<Result<ReviewResult, LLMError>>;
}
