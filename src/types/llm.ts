import type { Result } from "@/types/results";
import type { ReviewChunk, ReviewResult } from "@/types/review";

export type LLMError =
  | "LLM_API_KEY_MISSING"
  | "LLM_RATE_LIMITED"
  | "LLM_TIMEOUT"
  | "LLM_INVALID_RESPONSE"
  | "LLM_CONTEXT_TOO_LONG"
  | "LLM_UNKNOWN_ERROR";

export interface LLMService {
  analyzeReviewChunk(
    chunk: ReviewChunk,
  ): Promise<Result<ReviewResult, LLMError>>;
}
