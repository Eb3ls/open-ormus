# AGENTS.md — OpenOrmus

## 1. Project Overview

OpenOrmus is a web app for creating fictional characters, simulating multi-character scenes, and
evaluating LLM behavioural fidelity. The central design is a **single tool registry** consumed by
three channels: traditional UI, an internal AI assistant (OpenAI SDK chat loop), and an external
MCP server. Two-track architecture: production chat (live SSE) and evaluation (offline batch,
separate judge model).

---

## 2. Repository Layout

```
frontend/           Next.js 16 — App Router, Supabase Auth, Prisma client, shadcn/ui
mcp_server/         Express 5 MCP server (port 3001) — tool registry host
packages/shared/    Zod schemas, tool registry types, prompt templates (shared by all)
prisma/             Centralised schema.prisma + migrations (User, Character, Conversation, …)
docs/               Internal docs and skill files
.env.example        Required env vars — copy to .env.local before starting
scripts/            Dev helper scripts (test-mcp.sh)
```

---

## 3. Development Setup

**Required tools**

- **Bun ≥ 1.2** — package manager and runtime (`bun install`, `bun run`)
- **Node ≥ 20** — needed only by tooling that has no Bun binary (Prisma CLI migrations)
- **PostgreSQL 15+** locally, or a Supabase project with `DATABASE_URL` set
- **LLM provider** — any OpenAI-compatible API at `LLM_BASE_URL` (see §7); set `LLM_BASE_URL` and `LLM_API_KEY` in `.env.local`.

**Bootstrap**

```bash
bun install                                    # install all workspaces
cp .env.example .env.local                     # fill in DATABASE_URL, DIRECT_URL, LLM_BASE_URL, LLM_API_KEY
ln -sf ../.env.local frontend/.env.local       # frontend reads from root source of truth
ln -sf ../.env.local mcp_server/.env.local     # mcp_server reads from root source of truth
bun run prisma:migrate:dev                     # run DB migrations
bun run prisma:generate                        # generate both clients (required with Prisma 7)
bun run dev                                    # start frontend on :3000 and MCP on :3001
```

**Env file layout**

```
.env.local           ← single source of truth (gitignored)
frontend/.env.local  ← symlink → ../.env.local
mcp_server/.env.local← symlink → ../.env.local
```

---

## 4. Development Commands

| Goal | Command (run from repo root) |
| ---- | ---- |
| Both dev servers | `bun run dev` |
| Frontend dev server only | `bun run --cwd frontend dev` |
| MCP server dev (watch) only | `bun run --cwd mcp_server dev` |
| Build frontend | `bun run build` |
| Type-check all workspaces (frontend, shared, MCP) | `bun run typecheck` |
| Prisma migrate (dev) | `bun run prisma:migrate:dev` |
| Prisma generate client | `bun run prisma:generate` |
| Prisma Studio | `bun run prisma:studio` |
| Run tests (mcp_server) | `bun test --cwd mcp_server --isolate` (generate clients first; `DATABASE_URL` and `EXA_API_KEY` must be defined, placeholders suffice for mocked tests) |

---

## 5. Architecture & Boundaries

```
                   packages/shared/     ← single source of truth for types, schemas, tool defs
                      ▲      ▲      ▲
        frontend ─────┘      │      └────── mcp_server
        (Next.js)            │              (Express + MCP SDK)
                    /api/chat/stream
                  (chat loop → LLM provider)
                     │
                     └──► POST http://localhost:3001/mcp  (JWT-authed tool calls)
```

**Hard rules**

- `mcp_server/**` must not import from `frontend/**`, and vice versa.
- Tool input/output types live **only** in `packages/shared/` — both sides import from there.
- `prisma/schema.prisma` is the single schema file. Both workspaces point to it; neither owns it
  independently.
- All Prisma queries must be scoped by `userId` — even when Supabase RLS is active (belt-and-braces).
- **Production track** (chat streaming) and **evaluation track** (offline batch) must not share
  runtime state. They share DB tables and shared types, nothing else.

---

## 6. Stack Conventions

### TypeScript
- Config baseline: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — do not weaken.
- No `any`. Use `unknown` + Zod `.parse()` at every external boundary (API input, LLM output,
  DB JSON columns).
- Types are generated from Zod schemas in `packages/shared/schema/` — do not write duplicate
  hand-typed interfaces.

### Next.js 16 — App Router
- HTTP endpoints: `app/api/**/route.ts`. SSE: `ReadableStream` inside a `Response`.
- Supabase client **must** be instantiated through `lib/supabase/server.ts` (server components,
  route handlers) or `lib/supabase/client.ts` (client components). Never call
  `createServerClient` / `createBrowserClient` inline.

### Supabase Auth
- Server-side auth: `supabase.auth.getUser()` — **not** `getSession()`. `getSession()` reads the
  cookie without revalidating against the server and must not be trusted for security decisions.
- Every protected route handler starts with the user check:
  ```ts
  const { data: { user }, error } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ```

### Prisma 7
- Schema path: `prisma/schema.prisma` (root). Frontend `package.json` already overrides this.
- Singleton client: `lib/prisma.ts` (frontend), `src/db.ts` (mcp_server). Never `new PrismaClient()` ad hoc.
- `Character.sheet` is JSONB (`Json` type in Prisma) — do not normalise it into relational columns.

### LLM — OpenAI-compatible provider
- Frontend calls the provider directly via the OpenAI SDK: `LLM_BASE_URL` is the provider endpoint (any OpenAI-compatible URL), `LLM_API_KEY` is the provider key.
- **Never hardcode a model name** — pass model as an argument (`CONVERSATION_MODEL` env).
- Every LLM call must be logged: `model`, `prompt_hash`, `temperature_ms`, `latency_ms`, `userId`.

### MCP Server
- Transport: `StreamableHTTP` from `@modelcontextprotocol/sdk@^1.29`.
- Session map keyed by `mcp-session-id` header. Create a new session only when
  `isInitializeRequest(body)` is true; reuse otherwise.
- Every tool returns: `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
  Returning a plain object is a silent protocol violation.
- Tool IDs follow the pattern `mcp__openormus__<tool_name>` exactly. This string is also used
  in `allowedTools` on the agent side — a mismatch silently disables the tool.

### JWT (frontend ↔ mcp_server auth)
- `frontend /api/auth/tool-token` issues a JWT (max 5 min), payload `{ userId, exp }`,
  signed with `JWT_SECRET`.
- `mcp_server` validates the JWT on every request. `userId` extracted from the token is the
  **only** trusted tenancy source — never read it from the tool arguments.

### Zod
- A single major version must be used across all workspaces. Currently mismatched (`packages/shared`
  v4, `mcp_server` v3) — resolve before shared schemas are consumed in tools.
- Schemas are defined once in `packages/shared/schema/`, exported as Zod objects + inferred types.
  Both API validation (frontend) and MCP tool validation (mcp_server) import from there.

---

## 7. External Services (not managed by this repo)

**LLM provider**
Any OpenAI-compatible API reachable at `LLM_BASE_URL`. The frontend sends all LLM traffic directly
to this endpoint via the OpenAI SDK. If the provider is unavailable the chat handler must fail fast
with a clear error — no silent retries.

**Supabase**
PostgreSQL + Auth + (optionally) Storage. The repo stores only connection strings in `.env.local`.
Row Level Security policies live in Supabase, not in this repo.

---

## 8. Debug / Observability

Each long-running operation (chat session, eval run, character import) writes a structured log to:

```
debug/{component}/{YYYYMMDD_HHMMSS_<uuid>}_log.json
```

Minimum fields: `session_id`, `userId`, `component`, `event`, `timestamp`. If the log write fails,
log the failure to `stderr` — never swallow it silently.

---

## 9. Commit & PR Conventions

- Language: **English** (code and commits).
- Format: Conventional Commits — `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.
- One commit per logical change. No squash-everything-at-the-end PRs.
- No `Co-Authored-By:` trailers.
- Ask for explicit confirmation before pushing to `main` or `develop`.

---

## 10. Do Not

| Don't | Do instead |
| ---- | ---- |
| Add a new dependency without asking | State the alternative and rationale; wait for approval |
| Hardcode a model name in source (`"claude-opus-4-7"`) | Accept model as an argument via `CONVERSATION_MODEL` env |
| Hardcode MCP tool IDs as string literals in `allowedTools` | Derive from the shared registry: `toolIds(toolRegistry)` |
| Import Prisma in Next.js middleware (runs on Edge runtime) | Keep all Prisma in Node-runtime route handlers / Server Components |
| Call `supabase.auth.getSession()` server-side | Use `supabase.auth.getUser()` — see §6 Supabase Auth |
| Add a new MCP tool without first updating `packages/shared/schema/` | Schema-first: add Zod schema → infer types → implement handler |
| Refactor code adjacent to the requested change | Surgical changes only; mention unrelated issues but don't touch them |
| Introduce a pattern not discussed (event bus, CQRS, …) | Surface the gap as a question; do not invent |
| Push to `main` / `develop` without confirmation | Always ask first |

---

## 11. References

- `README.md` — project overview and quick start
- `.env.example` — canonical list of required environment variables

---

## 12. Worktree Setup

### Rules

- **Always work in a worktree** — never commit directly to `develop`.
- Finish the work in the worktree, then **squash merge into `develop`**.
- Worktrees branch from local `HEAD` — make sure you're on `develop` before creating one.

### Creating a worktree

Name the worktree with a type prefix using `-` as separator: `feature-character-import`, `fix-auth-token`, `refactor-tool-registry`. The resulting branch will be `worktree-<name>`.

**Inside a session** — ask Claude:
> "Create a worktree for `feature-character-import`"

Claude uses `EnterWorktree`, then symlinks env files from the main repo and runs project setup.

**From the CLI** — start an isolated session directly:
```bash
# make sure you're on develop first
claude --worktree feature-character-import
```

After entering, run setup manually:
```bash
ROOT="$(git worktree list --porcelain | head -1 | awk '{print $2}')"
ln -sf "$ROOT/.env" .env.local
ln -sf ../.env.local frontend/.env.local
ln -sf "$ROOT/mcp_server/.env" mcp_server/.env
bun install && bun run prisma:generate
```

### Finishing a worktree

```bash
# from develop
git merge --squash worktree-<name>
git commit -m "Squash merge worktree-<name> into develop"
git worktree remove .claude/worktrees/<name>
git branch -d worktree-<name>
```

### Verify before merging

```bash
bun run prisma:generate   # always — client is gitignored and may be stale after schema changes
bun run typecheck
bun run build
bun test --cwd mcp_server
```
