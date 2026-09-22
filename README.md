# OpenOrmus

A web app for creating fictional characters, simulating multi-character scenes, and evaluating LLM behavioural fidelity.

The core design is a **single tool registry** consumed by three channels simultaneously:

- **UI** — standard Next.js interface
- **AI assistant** — internal OpenAI SDK chat loop with tool access
- **MCP server** — external Model Context Protocol endpoint for agent clients

Two tracks: production chat (live SSE streaming) and evaluation (batch processing with separate evaluator models). Evaluation runs independently of the app and database, but still calls the configured LLM provider.

---

## Features

- **AI character assistant** (`/chat`) — conversational agent that creates, edits, and manages characters using the shared tool registry; launches multi-character scenes from the chat interface.
- **Multi-character conversations** (`/conversations`) — background-job simulation of scenes with ORCHESTRATOR or ROUND_ROBIN turn strategies (1–500 turns), streamed in real time.
- **MCP server** — the same 9 tools exposed to any external agent client over StreamableHTTP, JWT-authenticated.
- **Behavioural-fidelity evaluation** (`/evaluation`) — generate a conversation dataset, then run three independent analysis passes in parallel: character identification, persona reconstruction, and context drift.
- **LLM usage & cost tracking** (`/settings/usage`) — per-call logging of model, prompt hash, latency, and cost across all production and evaluation runs.

---

## Architecture

| Path               | Purpose                                                   | Port |
| ------------------ | --------------------------------------------------------- | ---- |
| `frontend/`        | Next.js 16 app — App Router, Supabase Auth, Prisma client | 3000 |
| `mcp_server/`      | Express 5 MCP server — tool registry host                 | 3001 |
| `packages/shared/` | Zod schemas, tool registry types, prompt templates        | —    |
| `prisma/`          | Centralised `schema.prisma` + migrations                  | —    |
| `evaluation/`      | Offline behavioural-fidelity pipeline — see [`evaluation/README.md`](evaluation/README.md) | — |
| `scripts/`         | Dev and validation helpers (`test-mcp.sh`, dataset/scenario validators) | — |
| `docs/`            | Internal documentation                                    | —    |
| `claude-plugin/`   | Packaged Claude Code plugin (agents, hooks, skills)       | —    |

### MCP Tools

All tools are namespaced as `mcp__openormus__<name>` and defined in `mcp_server/src/registry/tools/`.

**Character management**

| Tool | Purpose |
| ---- | ------- |
| `character_create` | Save a new character profile to the database |
| `character_list` | List all characters owned by the authenticated user |
| `character_update` | Update fields on an existing character profile |
| `character_delete` | Delete a character profile |
| `character_find` | Fuzzy-search saved characters by name or trait |

**Research**

| Tool | Purpose |
| ---- | ------- |
| `character_research` | Online research on a character from a TV/film/book show |
| `show_research` | Online research on a TV/film/book show |

**Conversations**

| Tool | Purpose |
| ---- | ------- |
| `conversation_start` | Start a background multi-character conversation job |
| `conversation_job_status` | Poll the status and output of a running conversation job |

---

## Tech Stack

- **Runtime / package manager:** Bun ≥ 1.2
- **Frontend:** Next.js 16, React 19, Tailwind CSS 4, shadcn/ui
- **Database:** PostgreSQL 15+ (hosted on Supabase)
- **ORM:** Prisma 7.8 — schema at `prisma/schema.prisma`, consumed by both workspaces
- **Auth:** Supabase Auth (`@supabase/ssr`) for users; short-lived JWT for frontend → MCP calls
- **LLM:** OpenAI SDK pointed at any OpenAI-compatible provider via `LLM_BASE_URL`
- **MCP transport:** `StreamableHTTP` from `@modelcontextprotocol/sdk ^1.29`
- **Validation:** Zod — schemas defined once in `packages/shared/`, imported everywhere

---

## Prerequisites

| Tool          | Version | Notes                                   |
| ------------- | ------- | --------------------------------------- |
| Bun           | ≥ 1.2   | Primary package manager and runtime     |
| Node          | ≥ 20    | Required only for Prisma CLI migrations |
| PostgreSQL    | 15+     | Local instance or a Supabase project    |
| LLM provider  | any     | Any OpenAI-compatible API (e.g. Ollama, OpenRouter, OpenAI). Set `LLM_BASE_URL` + `LLM_API_KEY` in `.env.local` |

---

## Environment Variables

Create the root env file and symlink it into both workspaces:

```bash
cp .env.example .env.local
ln -sf ../.env.local frontend/.env.local
ln -sf ../.env.local mcp_server/.env.local
```

| Variable                               | Required    | Description                                                                                                           |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | Yes         | Pooled connection string (Transaction mode, port 6543) — used for runtime queries                                     |
| `DIRECT_URL`                           | Yes         | Direct connection string (no pooler, port 5432) — used by Prisma CLI for migrations                                   |
| `NEXT_PUBLIC_SUPABASE_URL`             | Yes         | Your Supabase project URL, e.g. `https://xxxx.supabase.co`                                                            |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes         | Supabase anon/publishable key (`sb_publishable_…`)                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`            | Yes         | Supabase service role key — server-side only, never expose to the client                                              |
| `NEXT_PUBLIC_SITE_URL`                 | Yes         | Base URL used in auth email links — `http://localhost:3000` for local dev                                             |
| `EXA_API_KEY`                          | No          | API key for Exa search (required only if search tools are enabled)                                                    |
| `MCP_PORT`                             | No          | MCP server port (default: `3001`)                                                                                     |
| `MCP_SERVER_URL`                       | No          | Full MCP endpoint URL (default: `http://localhost:3001/mcp`)                                                          |
| `MCP_PUBLIC_URL`                       | No          | Public-facing MCP base URL — used in OAuth discovery (default: `http://localhost:3001`)                               |
| `FRONTEND_INTERNAL_URL`                | No          | URL the MCP server uses to call frontend internal API routes (default: `http://localhost:3000`)                        |
| `MCP_AUTH_DISABLED`                    | No          | Set to `"true"` in local dev to skip JWT validation between frontend and MCP server                                   |
| `JWT_SECRET`                           | Conditional | Required when `MCP_AUTH_DISABLED` is not set. Signs the short-lived tokens issued by `/api/auth/tool-token`           |
| `LLM_BASE_URL`                         | Yes         | OpenAI-compatible provider URL, e.g. `http://localhost:11434/v1` (Ollama) or `https://openrouter.ai/api/v1`          |
| `LLM_API_KEY`                          | Yes         | API key for the provider at `LLM_BASE_URL`                                                                            |
| `CONVERSATION_MODEL`                   | Yes         | Model name passed directly to the provider, e.g. `gemini/gemini-2.5-flash-lite`                                      |
| `EVAL_ALLOWED_EMAILS`                  | No          | Comma-separated list of emails allowed to access the evaluation dashboard                                             |
| `EVAL_RESULTS_PATH`                    | For evaluation | Absolute path to the directory where evaluation results are stored                                                 |

> **Note on `MCP_AUTH_DISABLED`:** When set to `"true"`, the MCP server accepts tool calls without a valid JWT. Never enable this in production.

---

## Setup

```bash
# 1. Install all workspace dependencies
bun install

# 2. Configure environment
cp .env.example .env.local
ln -sf ../.env.local frontend/.env.local
ln -sf ../.env.local mcp_server/.env.local
# Edit .env.local with your credentials (DATABASE_URL, DIRECT_URL, LLM_BASE_URL, …)

# 3. Run database migrations
bun run prisma:migrate:dev

# 4. Generate both Prisma clients (Prisma 7 migrations do not generate them)
bun run prisma:generate

# 5. Start both servers (frontend on :3000, MCP on :3001)
bun run dev
```

After setup, open [http://localhost:3000](http://localhost:3000).

---

## Commands

### Development

| Command       | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `bun run dev` | Start both the Next.js dev server (port 3000) and MCP server (port 3001) |

### Build & Production

| Command         | Description                               |
| --------------- | ----------------------------------------- |
| `bun run build` | Build the Next.js frontend for production                                    |
| `bun run start` | Start both the frontend and MCP server in production mode                    |

### Database (Prisma)

| Command                         | Description                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `bun run prisma:migrate:dev`    | Create and apply a new migration in development (prompts for a migration name) |
| `bun run prisma:migrate:deploy` | Apply pending migrations — use this in CI/CD and production                    |
| `bun run prisma:migrate:status` | Show which migrations have been applied and which are pending                  |
| `bun run prisma:generate`       | Generate both Prisma clients after a fresh install or schema changes            |
| `bun run prisma:studio`         | Open Prisma Studio (visual DB browser) at `http://localhost:5555`              |

### Type Checking

| Command                      | Description                                   |
| ---------------------------- | --------------------------------------------- |
| `bun run typecheck`          | Type-check all workspaces (frontend + shared + MCP server) |
| `bun run typecheck:frontend` | Type-check the frontend only                  |
| `bun run typecheck:shared`   | Type-check the shared package only            |
| `bun run typecheck:mcp`      | Type-check the MCP server only                |

Run the MCP tests with `bun test --cwd mcp_server --isolate` after generating the Prisma clients. The mocked tests still require `DATABASE_URL` and `EXA_API_KEY` to be defined during module initialization; placeholder values suffice for these tests.

---

## Evaluation

The batch evaluation pipeline analyzes generated dialogue using three independent passes: judge guessing, persona reconstruction, and context drift. Generate the dataset first, then run the analyses in parallel. See [`evaluation/README.md`](evaluation/README.md) for the commands, required configuration, outputs, and interpretation limits.
