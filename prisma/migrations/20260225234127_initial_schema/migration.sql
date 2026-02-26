-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ORG', 'USER');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommentCategory" AS ENUM ('SECURITY', 'BUGS', 'PERFORMANCE', 'STYLE', 'BEST_PRACTICES');

-- CreateEnum
CREATE TYPE "CommentSeverity" AS ENUM ('CRITICAL', 'WARNING', 'SUGGESTION', 'NITPICK');

-- CreateTable
CREATE TABLE "installations" (
    "id" TEXT NOT NULL,
    "githubInstallationId" INTEGER NOT NULL,
    "githubAccountLogin" TEXT NOT NULL,
    "githubAccountType" "AccountType" NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "githubRepoId" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "issuesFound" INTEGER NOT NULL DEFAULT 0,
    "processingTimeMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_comments" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "category" "CommentCategory" NOT NULL,
    "severity" "CommentSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "suggestion" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "githubCommentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installations_githubInstallationId_key" ON "installations"("githubInstallationId");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_installationId_githubRepoId_key" ON "repositories"("installationId", "githubRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_repositoryId_commitSha_key" ON "reviews"("repositoryId", "commitSha");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
