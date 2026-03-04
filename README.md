# Code Review Bot

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

A GitHub App that automatically reviews pull requests using AST-aware analysis and LLM-powered code review. Posts inline comments with severity levels, categories, and fix suggestions directly on your PRs.

## Features

- **AST-aware analysis** — Parses code structure with tree-sitter (TypeScript, Python, Go, Rust, Java, JavaScript)
- **Inline PR comments** — Posts contextual review comments on exact diff lines with severity badges
- **Delta reviews** — Only reviews files changed since last push (not the entire PR again)
- **Background processing** — BullMQ job queue with retry logic and dead letter handling
- **Dashboard** — OAuth-protected UI to manage repos, view review history, and configure settings

## Architecture

```
GitHub Webhook
      │
      ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Next.js    │────▶│   BullMQ     │────▶│   Worker     │
│  Route      │     │   Queue      │     │   Process    │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                │
                    ┌───────────────────────────┤
                    ▼               ▼           ▼
              ┌──────────┐  ┌───────────┐  ┌──────────┐
              │  Fetch   │  │  Parse    │  │  Post    │
              │  Diff    │  │  AST +    │  │  Review  │
              │  (GitHub)│  │  LLM Call │  │  (GitHub)│
              └──────────┘  └───────────┘  └──────────┘
                                │
                                ▼
                         ┌────────────┐
                         │ PostgreSQL │
                         │  (Prisma)  │
                         └────────────┘
```

**Data flow:** Webhook → Validate Signature → Enqueue Job → Worker: Fetch Diff → Parse AST → Build Context → LLM Analysis → Map Comments → Post Review → Save to DB

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict mode) |
| Database | PostgreSQL + Prisma ORM |
| Queue | BullMQ + Valkey (Redis-compatible) |
| AST Parsing | web-tree-sitter (WASM) |
| Auth | Auth.js v5 (GitHub OAuth) |
| UI | shadcn/ui + Tailwind CSS |
| Linting | Biome |
| Testing | Vitest + Playwright |

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for PostgreSQL + Valkey)
- A [GitHub App](https://github.com/settings/apps/new) with permissions: `pull_requests` (read/write), `contents` (read), `metadata` (read)

### Setup

```bash
# Clone the repository
git clone <repo-url>
cd ai-code-review-bot

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env
# Fill in your GitHub App credentials, database URL, and API key

# Start infrastructure (PostgreSQL + Valkey)
docker compose up -d

# Run database migrations
pnpm db:migrate

# Generate Prisma client
pnpm db:generate

# Start development server
pnpm dev

# In a separate terminal, start the background worker
pnpm worker:dev
```

### Environment Variables

See `.env.example` for all required variables. Key ones:

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | Your GitHub App ID |
| `GITHUB_PRIVATE_KEY` | RSA private key from GitHub App settings |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret for signature verification |
| `GITHUB_CLIENT_ID` | OAuth client ID for dashboard auth |
| `GITHUB_CLIENT_SECRET` | OAuth client secret for dashboard auth |
| `DATABASE_URL` | PostgreSQL connection string |
| `VALKEY_URL` | Valkey/Redis connection string |
| `ANTHROPIC_API_KEY` | API key for LLM analysis |
| `NEXTAUTH_SECRET` | Secret for session encryption |

## Development

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Next.js dev server |
| `pnpm worker:dev` | Start background worker |
| `pnpm validate` | Run all checks (lint + type-check + tests) |
| `pnpm test` | Run Vitest tests |
| `pnpm test:coverage` | Run tests with coverage report |
| `pnpm type-check` | TypeScript type checking |
| `pnpm lint:fix` | Auto-fix lint and format issues |
| `pnpm db:studio` | Open Prisma Studio |

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── api/webhooks/       # GitHub webhook endpoint
│   ├── dashboard/          # Protected dashboard routes
│   └── page.tsx            # Landing page
├── auth.ts                 # Auth.js configuration
├── components/ui/          # shadcn/ui components
├── lib/
│   ├── db/                 # Prisma client + queries
│   ├── github/             # GitHub API + webhook handlers
│   ├── llm/                # LLM client, prompts, response parser
│   ├── queue/              # BullMQ producer, processor, types
│   └── review/             # Diff parser, AST parser, context builder, comment mapper, engine
├── types/                  # Shared types (branded, results, errors, review, github, llm)
└── generated/              # Prisma generated client
worker/
└── index.ts                # Standalone BullMQ worker process
tests/
├── unit/                   # Unit tests (review/, llm/)
├── integration/            # Integration tests (webhook, pipeline, queue)
├── e2e/                    # Playwright E2E tests
├── fixtures/               # Test data (diffs, LLM responses)
└── helpers/                # Test factories and utilities
```

## Testing

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run E2E tests (requires dev server running)
npx playwright test

# Run full validation suite
pnpm validate
```

Coverage targets: 80%+ on `src/lib/review/` and `src/lib/llm/`.

## License

MIT
