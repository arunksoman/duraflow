# CLAUDE.md (backend)

This file provides guidance to Claude Code (claude.ai/code) when working with code in `backend/`. See the root [CLAUDE.md](../CLAUDE.md) for the monorepo overview and [../frontend/CLAUDE.md](../frontend/CLAUDE.md) for the SvelteKit app this serves.

## Project Configuration

- **Language**: Go
- **Web framework**: [Huma v2](https://huma.rocks/) (OpenAPI-first — request/response structs auto-generate the OpenAPI 3.1 spec, no annotations to keep in sync) on top of [Echo](https://echo.labstack.com/) via the `humaecho` adapter
- **ORM**: [GORM](https://gorm.io/) — `AutoMigrate` on every startup, no separate migration tooling
- **Database**: SQLite by default (`github.com/glebarez/sqlite`, pure Go, no CGO); Postgres wired and ready (`gorm.io/driver/postgres`) — flip `database.driver: postgres` + a DSN in config
- **Config**: [viper](https://github.com/spf13/viper) — built-in defaults (`internal/config/config.go`'s `Load()`) → `DURAFLOW_*` env overrides. There's no config file in the repo; `docker-compose.yml` sets everything via env vars. Drop a `config/config.yaml` back in locally if you want file-based overrides instead of exporting env vars for `go run` — `Load()` still reads one if present, it's just optional
- **API docs**: auto-generated OpenAPI 3.1 at `/openapi.json`, rendered with [Scalar](https://scalar.com/) at `/docs`
- **Execution**: [Temporal](https://temporal.io/) via `go.temporal.io/sdk`, actually running workflows via the [Zigflow CLI](https://github.com/zigflow/zigflow) (`go install github.com/zigflow/zigflow@latest`) — see the Execution section below

## Commands

All commands below run from `backend/` (e.g. `cd backend` first, or `go run ./cmd/server` etc. with `-C backend`).

```sh
go run ./cmd/server      # start the server (built-in defaults + DURAFLOW_* env vars) — needs Temporal reachable
go build ./...           # compile everything
go vet ./...             # static checks
go mod tidy              # sync go.mod/go.sum after adding/removing imports
```

Needs a Temporal dev server reachable at `temporal.address` (default `localhost:7233`, override with `DURAFLOW_TEMPORAL_ADDRESS`) and the `zigflow` CLI on PATH to actually run workflows — the server still starts and serves the API without either, it just can't spawn workers or execute anything. See root `README.md`'s "Quickstart (without Docker)" for how to get both running locally, or use `docker compose up` from the repo root instead.

There is no test suite yet.

## Architecture

```
cmd/server/main.go        # wiring: config → db (+ seed admin) → temporal client + worker manager
                           # (+ start every stored workflow's worker) → router → listen → signal-based shutdown
internal/
  config/config.go        # viper loader — all fields have built-in defaults, see Load()
  db/db.go                # gorm.Open (sqlite|postgres via cfg.Database.Driver) + AutoMigrate
  models/                 # GORM models: User, Project, Workflow, Execution, Schedule, Worker
  auth/                   # bcrypt hashing, JWT issue/verify (enforcement is Huma-level, see api/router.go)
  temporalexec/            # LazyClient (Temporal client, dials on first use) + WorkerManager
                           # (spawns/kills `zigflow run` subprocesses — see Execution below)
  api/
    router.go              # builds the Echo instance + Huma API, registers every operation,
                            # and owns the bearer-auth Huma middleware (checks Operation.Security)
    auth.go / projects.go / workflows.go / executions.go / schedules.go / workers.go
                            # one file per resource, each a registerXRoutes(api, deps, base) function
data/                      # sqlite file + per-workflow DSL YAML files live here (gitignored)
Dockerfile                 # multi-stage: builds both the server binary and the zigflow CLI into
                            # one runtime image, since WorkerManager spawns zigflow as a subprocess
```

**Migrations**: `db.Open` runs `conn.AutoMigrate(&models.User{}, ...)` unconditionally on startup — that's the entire migration story. There are no versioned migration files. Adding a field to a model is enough; GORM adds the column. Switching to Postgres later requires no code changes, just config.

**Auth**: every model embeds `models.Base` (UUID `id` + `createdAt`/`updatedAt`, JSON tags matching the frontend's camelCase TS types in `frontend/src/lib/types/index.ts`). `POST /api/auth/login` is the only unauthenticated `/api/*` route; everything else requires `Authorization: Bearer <jwt>`, enforced in `router.go`'s `authMiddleware` — it inspects `huma.Operation.Security` for the `bearerAuth` scheme rather than gating routes by path, so a new operation is protected by default unless you explicitly omit `Security: authSecurity()`. A default admin (`DURAFLOW_SEEDADMIN_EMAIL`/`DURAFLOW_SEEDADMIN_PASSWORD`, set in `docker-compose.yml`) is created on first boot if the `users` table is empty.

**Adding a new operation**: define the `XInput`/`XOutput` structs (path/query params via struct tags, JSON body under a `Body` field) in the relevant `internal/api/*.go` file, then `huma.Register(api, huma.Operation{...}, handler)` inside that file's `registerXRoutes`. The OpenAPI spec and Scalar docs pick it up automatically — nothing else to update.

**Execution**: a workflow's DSL is not just stored — every workflow whose `dsl` column is non-blank gets its own `zigflow run -f <id>.yaml` subprocess (`internal/temporalexec/manager.go`'s `WorkerManager`, one process per workflow, restarted on every DSL change since `zigflow run` has no hot-reload). That process is a real Temporal worker: it registers the DSL's `document.workflowType` on `document.taskQueue` and polls Temporal. `workflows.go`'s create/update/delete handlers call `syncWorkerRegistration`/`stopWorkerRegistration`, which both (re)start/stop that subprocess *and* upsert a row in the `workers` table so the frontend's Workers page reflects real processes, not a static list. `executions.go`'s `create-execution` handler is a genuine Temporal client call (`client.ExecuteWorkflow`) — it 502s if Temporal is unreachable or no worker has registered that task queue yet, rather than faking a result. Each spawned worker gets an OS-assigned metrics/health-check port (`--metrics-listen-address`/`--health-listen-address`) instead of zigflow's fixed defaults (`:9090`/`:3000`) — otherwise every worker past the first on one host would crash on startup fighting over those ports. `Sync` also blocks until the new worker's health endpoint answers (up to 15s) before returning, because the frontend's Run button saves the DSL and starts an execution back to back — without the wait, that first run intermittently 502s against a worker that hasn't finished registering.

**Run telemetry (what the UI shows after a run)**: Temporal history alone can't describe a zigflow run — `set`/`switch` leave no correlatable events, and `for`/`fork`/`try` bodies execute as *separate child workflows* whose activities never appear in the parent's history. So every spawned worker is also handed a `--cloudevents-config <id>.cloudevents.yaml` (written by `WorkerManager.writeCloudEventsConfig`) pointing at this server's own ingest endpoint, and zigflow POSTs one CloudEvent per task lifecycle moment — `dev.zigflow.task.started/retried/cancelled/faulted/completed` plus `workflow.started/completed` — each carrying that task's input, output and the workflow state.

- `internal/api/telemetry.go` receives them at `POST /api/internal/zigflow/events` (no `Security:`, authenticated instead by a shared `X-Duraflow-Token` generated per boot). zigflow's emitter is **not replay-guarded** and blocks the running workflow on the HTTP response, so this handler does one indexed insert and nothing else; duplicates from replays are collapsed by a content hash (`dedupeKeyFor`, deliberately excluding the re-stamped CloudEvent time).
- `internal/temporalexec/resolver.go` then works out, on its own goroutine, which run each event belongs to — walking Temporal's parent chain (never string-parsing ids) and caching the answer in `workflow_execution_refs`. Synthetic `workflow_(for|fork|try|catch)_*` children become a `ScopePath` on the parent's canvas; a real `run: workflow` child gets its own `Execution` row (id = its Temporal workflow id) with `ParentExecutionID`/`ParentTaskName` set, which is what powers the UI's child-run drill-down.
- `internal/events/broker.go` fans resolved events out to watchers. `GET /executions/{id}/watch` replays the stored backlog from `?afterSeq=` then streams live, so a reconnect or a page opened on a finished run sees the identical timeline; `GET /executions/{id}/events` is the same data without a stream.
- Nothing in Temporal pushes "your workflow finished", so `watchTerminal` runs one goroutine per running execution (started by `create-execution`, by child discovery, and by a boot sweep over `status = 'running'`) to persist the terminal status, output and — new — the failure message on `Execution.Error`.

**Run types, listing and deletion**: `Execution.Trigger` (column `run_trigger` — `TRIGGER` is an SQL keyword) records what started a run: `manual` (every run today; `create-execution` defaults to it), with `scheduled`/`backfill` reserved for the scheduler. Child runs copy their root's trigger in `Resolver.ensureChildExecution`. `GET /executions` is the cross-project list, filtered by `workflowId`/`projectId`/`trigger`/`status`/`from`/`to` and paged with `limit`/`offset`, returning `{items, total}` with workflow and project names joined in two batched reads. `DELETE /executions/{id}` and `POST /executions/delete` (bulk, all-or-nothing) live in `internal/api/execution_delete.go` and delete a run *tree* completely: child runs, events (including still-unresolved ones matched by Temporal id prefix), `workflow_execution_refs`, the resolver's in-memory cache (`Resolver.Forget`) and — best-effort, in the background — Temporal's history for the root and every child/synthetic workflow. Only root runs can be deleted; a still-running run returns 409 unless `force` is set, in which case it's terminated first. Terminal-status writes go through `persistTerminalResult` (an `UPDATE`, never `Save`) because `Save` upserts and would resurrect a run deleted while its `watchTerminal` goroutine was still waiting on Temporal.

The watch stream dedupes by the set of seqs already sent rather than a high-water mark: the resolver can publish an event after one with a higher seq, and a high-water mark would drop it.

`internal/temporalexec/history.go` is now only what's left of the history approach: `ExtractTaskName` (which DSL task started a child workflow), `MapWorkflowStatus`, `EventTypeIsWorkflowClose`. Don't reconstruct run state from history in parallel with CloudEvents — two sources that disagree is worse than one with known gaps.
