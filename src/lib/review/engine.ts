import {
  completeReview,
  createReviewRecord,
  failReview,
  findExistingReviewByCommitSha,
  findRepositoryByFullName,
  saveReviewComments,
  updateReviewStatus,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { initializeAstParser, parseFileAst } from "@/lib/review/ast-parser";
import {
  buildReviewSummary,
  mapFindingsToGitHubComments,
} from "@/lib/review/comment-mapper";
import { buildReviewContext } from "@/lib/review/context-builder";
import { parseUnifiedDiff } from "@/lib/review/diff-parser";
import type { ReviewEngineError } from "@/types/errors";
import type { GitHubService } from "@/types/github";
import type { LLMService } from "@/types/llm";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type {
  AstFileContext,
  MappedReviewComment,
  ReviewEngineResult,
  ReviewFinding,
  ReviewRequest,
  UnmappedFinding,
} from "@/types/review";

function splitRepositoryFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo] = fullName.split("/");
  return { owner: owner ?? "", repo: repo ?? "" };
}

async function fetchFileContentsForDiff(
  githubService: GitHubService,
  owner: string,
  repo: string,
  commitSha: string,
  filePaths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const contents = new Map<string, string>();

  const results = await Promise.allSettled(
    filePaths.map(async (filePath) => {
      const result = await githubService.fetchFileContent(
        owner,
        repo,
        filePath,
        commitSha,
      );
      if (result.success) {
        contents.set(filePath, result.data);
      } else {
        logger.warn("Failed to fetch file content, skipping AST enrichment", {
          filePath,
          error: result.error,
        });
      }
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Unexpected error fetching file content", {
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }

  return contents;
}

async function parseAstContextsForFiles(
  fileContents: ReadonlyMap<string, string>,
  filePaths: readonly { path: string; language: string | null }[],
): Promise<ReadonlyMap<string, AstFileContext>> {
  const astContexts = new Map<string, AstFileContext>();

  const initResult = await initializeAstParser();
  if (!initResult.success) {
    logger.warn("AST parser initialization failed, skipping AST enrichment", {
      error: initResult.error,
    });
    return astContexts;
  }

  for (const { path, language } of filePaths) {
    if (!language) continue;

    const content = fileContents.get(path);
    if (!content) continue;

    const supportedLanguage = language as Parameters<typeof parseFileAst>[1];
    const result = await parseFileAst(content, supportedLanguage, path);
    if (result.success) {
      astContexts.set(path, result.data);
    } else {
      logger.warn("AST parsing failed for file, skipping enrichment", {
        filePath: path,
        language,
        error: result.error,
      });
    }
  }

  return astContexts;
}

async function analyzeAllChunks(
  llmService: LLMService,
  chunks: readonly import("@/types/review").ReviewChunk[],
): Promise<
  Result<
    {
      findings: ReviewFinding[];
      summary: string;
      totalInputTokens: number;
      totalOutputTokens: number;
    },
    "REVIEW_LLM_FAILED"
  >
> {
  const allFindings: ReviewFinding[] = [];
  const summaries: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const chunk of chunks) {
    const result = await llmService.analyzeReviewChunk(chunk);
    if (!result.success) {
      logger.error("LLM analysis failed for chunk", {
        error: result.error,
        fileCount: chunk.files.length,
      });
      return err("REVIEW_LLM_FAILED");
    }

    allFindings.push(...result.data.findings);
    if (result.data.summary) {
      summaries.push(result.data.summary);
    }
    totalInputTokens += result.data.tokenUsage.inputTokens;
    totalOutputTokens += result.data.tokenUsage.outputTokens;
  }

  const summary =
    summaries.length > 0
      ? summaries.join("\n\n")
      : "No significant issues found.";

  return ok({
    findings: allFindings,
    summary,
    totalInputTokens,
    totalOutputTokens,
  });
}

export async function executeReview(
  request: ReviewRequest,
  githubService: GitHubService,
  llmService: LLMService,
): Promise<Result<ReviewEngineResult, ReviewEngineError>> {
  const startTime = Date.now();
  const { owner, repo } = splitRepositoryFullName(request.repositoryFullName);

  logger.info("Starting review", {
    repository: request.repositoryFullName,
    pullRequest: request.pullRequestNumber,
    commitSha: request.commitSha,
  });

  // Step 1: Look up repository in DB
  const repoResult = await findRepositoryByFullName(request.repositoryFullName);
  if (!repoResult.success) {
    logger.error("Failed to look up repository", { error: repoResult.error });
    return err("REVIEW_DB_ERROR");
  }
  if (!repoResult.data) {
    logger.error("Repository not found or disabled", {
      repository: request.repositoryFullName,
    });
    return err("REVIEW_DB_ERROR");
  }
  const repositoryId = repoResult.data.id;

  // Step 2: Idempotency check
  const existingResult = await findExistingReviewByCommitSha(
    repositoryId,
    request.commitSha,
  );
  if (!existingResult.success) {
    logger.error("Idempotency check failed", { error: existingResult.error });
    return err("REVIEW_DB_ERROR");
  }
  if (existingResult.data) {
    logger.info("Review already exists for commit, skipping", {
      reviewId: existingResult.data.id,
      commitSha: request.commitSha,
    });
    return err("REVIEW_ALREADY_EXISTS");
  }

  // Step 3: Create PENDING review record
  const createResult = await createReviewRecord({
    repositoryId,
    pullRequestNumber: request.pullRequestNumber,
    commitSha: request.commitSha,
  });
  if (!createResult.success) {
    logger.error("Failed to create review record", {
      error: createResult.error,
    });
    return err("REVIEW_DB_ERROR");
  }
  const reviewId = createResult.data.id;

  // Step 4: Update to PROCESSING
  await updateReviewStatus(reviewId, "PROCESSING");

  // Step 5: Fetch diff from GitHub
  const diffResult = await githubService.fetchPullRequestDiff(
    owner,
    repo,
    request.pullRequestNumber,
  );
  if (!diffResult.success) {
    logger.error("Failed to fetch diff", { error: diffResult.error });
    await failReview(reviewId, "Failed to fetch PR diff");
    return err("REVIEW_DIFF_FETCH_FAILED");
  }

  // Step 6: Parse diff
  const parsedDiffResult = parseUnifiedDiff(diffResult.data);
  if (!parsedDiffResult.success) {
    logger.error("Failed to parse diff", { error: parsedDiffResult.error });
    await failReview(reviewId, "Failed to parse PR diff");
    return err("REVIEW_DIFF_PARSE_FAILED");
  }
  const parsedDiff = parsedDiffResult.data;

  if (parsedDiff.files.length === 0) {
    await completeReview({
      reviewId,
      summary: "No reviewable files in this PR.",
      issuesFound: 0,
      processingTimeMs: Date.now() - startTime,
    });
    return ok({
      reviewId,
      issuesFound: 0,
      processingTimeMs: Date.now() - startTime,
      summary: "No reviewable files in this PR.",
    });
  }

  // Step 7: Fetch file contents for AST parsing
  const reviewableFiles = parsedDiff.files.filter(
    (f) => !f.isBinary && f.changeType !== "deleted",
  );
  const filePaths = reviewableFiles.map((f) => f.filePath);

  const fileContents = await fetchFileContentsForDiff(
    githubService,
    owner,
    repo,
    request.commitSha,
    filePaths,
  );

  // Step 8: Parse ASTs (graceful — failures skip enrichment)
  const fileLanguages = reviewableFiles.map((f) => ({
    path: f.filePath,
    language: f.language,
  }));
  const astContexts = await parseAstContextsForFiles(
    fileContents,
    fileLanguages,
  );

  // Step 9: Build review context
  const contextResult = buildReviewContext(
    parsedDiff,
    astContexts,
    fileContents,
  );
  if (!contextResult.success) {
    logger.warn("Context build returned no reviewable files", {
      error: contextResult.error,
    });
    await completeReview({
      reviewId,
      summary: "No reviewable content after filtering.",
      issuesFound: 0,
      processingTimeMs: Date.now() - startTime,
    });
    return ok({
      reviewId,
      issuesFound: 0,
      processingTimeMs: Date.now() - startTime,
      summary: "No reviewable content after filtering.",
    });
  }
  const chunks = contextResult.data;

  // Step 10: Call LLM for each chunk
  const llmResult = await analyzeAllChunks(llmService, chunks);
  if (!llmResult.success) {
    await failReview(reviewId, "LLM analysis failed");
    return err("REVIEW_LLM_FAILED");
  }
  const { findings, summary: llmSummary } = llmResult.data;

  logger.info("LLM analysis complete", {
    findingCount: findings.length,
    inputTokens: llmResult.data.totalInputTokens,
    outputTokens: llmResult.data.totalOutputTokens,
  });

  // Step 11: Map findings to GitHub comments
  const mappingResult = mapFindingsToGitHubComments(findings, parsedDiff);
  if (!mappingResult.success) {
    await failReview(reviewId, "Comment mapping failed");
    return err("REVIEW_POST_FAILED");
  }
  const { mappedComments, unmappedFindings } = mappingResult.data;

  // Step 12: Build review summary
  const reviewSummary = buildReviewSummary(
    llmSummary,
    mappedComments.length,
    unmappedFindings,
  );

  // Step 13: Post review to GitHub
  const reviewEvent = findings.some((f) => f.severity === "CRITICAL")
    ? "REQUEST_CHANGES"
    : "COMMENT";

  const postResult = await githubService.postPullRequestReview(
    owner,
    repo,
    request.pullRequestNumber,
    {
      commitSha: request.commitSha,
      body: reviewSummary,
      event: reviewEvent,
      comments: mappedComments.map((comment: MappedReviewComment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.formattedBody,
      })),
    },
  );

  if (!postResult.success) {
    logger.error("Failed to post review to GitHub", {
      error: postResult.error,
    });
    // Still save to DB even if posting fails
  } else {
    logger.info("Review posted to GitHub", {
      githubReviewId: postResult.data.githubReviewId,
      postedComments: postResult.data.postedCommentCount,
    });
  }

  // Step 14: Save comments to DB
  const allFindings = [
    ...mappedComments.map((c: MappedReviewComment) => c.finding),
    ...unmappedFindings.map((u: UnmappedFinding) => u.finding),
  ];
  const saveResult = await saveReviewComments(
    allFindings.map((finding) => ({
      reviewId,
      filePath: finding.filePath,
      lineNumber: finding.lineNumber,
      category: finding.category,
      severity: finding.severity,
      message: finding.message,
      suggestion: finding.suggestion || null,
      confidence: finding.confidence,
      githubCommentId: null,
    })),
  );

  if (!saveResult.success) {
    logger.error("Failed to save review comments to DB", {
      error: saveResult.error,
    });
  }

  // Step 15: Complete review
  const processingTimeMs = Date.now() - startTime;
  const completeResult = await completeReview({
    reviewId,
    summary: reviewSummary,
    issuesFound: findings.length,
    processingTimeMs,
  });

  if (!completeResult.success) {
    logger.error("Failed to complete review record", {
      error: completeResult.error,
    });
  }

  logger.info("Review complete", {
    reviewId,
    issuesFound: findings.length,
    processingTimeMs,
    posted: postResult.success,
  });

  return ok({
    reviewId,
    issuesFound: findings.length,
    processingTimeMs,
    summary: reviewSummary,
  });
}
