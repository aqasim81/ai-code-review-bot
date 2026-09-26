-- Each chunk's analysis is kept on its review until the review is completed,
-- so a retry of the job analyses only the chunks that did not succeed (#143).
CREATE TABLE "review_chunk_analyses" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "chunkKey" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_chunk_analyses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_chunk_analyses_reviewId_chunkKey_key" ON "review_chunk_analyses"("reviewId", "chunkKey");

ALTER TABLE "review_chunk_analyses" ADD CONSTRAINT "review_chunk_analyses_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
