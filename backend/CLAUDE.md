# CLAUDE.md (backend)

This file provides guidance to Claude Code (claude.ai/code) when working with code in `backend/`. See the root [CLAUDE.md](../CLAUDE.md) for the monorepo overview and [../frontend/CLAUDE.md](../frontend/CLAUDE.md) for the SvelteKit app this serves.

## Project Configuration

- **Language**: Go
- **Web framework**: [Huma v2](https://huma.rocks/) (OpenAPI-first — request/response structs auto-generate the OpenAPI 3.1 spec, no annotations to keep in sync) on top of [Echo](https://echo.labstack.com/) via the `humaecho` adapter
- **ORM**: [GORM](https://gorm.io/) — `AutoMigrate` on every startup, no separate migration tooling
- **Database**: SQLite by default (`github.com/glebarez/sqlite`, pure Go, no CGO) for the single-process mode; Postgres (`gorm.io/driver/postgres`) for anything with more than one process — flip `database.driver: postgres` + a DSN in config
- **Config**: [viper](https://github.com/spf13/viper) — built-in defaults (`internal/config/config.go`'s `Load()`) → `DURAFLOW_*` env overrides. There's no config file in the repo; `docker-compose.yml` sets everything via env vars. Drop a `config/config.yaml` back in locally if you want file-based overrides instead of exporting env vars for `go run` — `Load()` still reads one if present, it's just optional
- **API docs**: auto-generated OpenAPI 3.1 at `/openapi.json`, rendered with [Scalar](https://scalar.com/) at `/docs`
- **Execution**: [Temporal](https://temporal.io/) via `go.temporal.io/sdk`, running workflows through [zigflow](https://github.com/zigflow/zigflow) **as a Go library** (`github.com/zigflow/zigflow`, pinned in `go.mod`) inside this binary's worker pool — there is no zigflow CLI and no subprocess. See the Execution section below
- **Roles**: one binary, two roles picked by `DURAFLOW_ROLES` — `api` and `worker`, both by default. Any number of copies of either; see Scaling below

## Commands

All commands below run from `backend/` (e.g. `cd backend` first, or `go run ./cmd/server` etc. with `-C backend`).

```sh
go run ./cmd/server      # start the server (built-in defaults + DURAFLOW_* env vars) — needs Temporal reachable
go build ./...           # compile everything
go vet ./...             # static checks
go mod tidy              # sync go.mod/go.sum after adding/removing imports
```

Needs a Temporal dev server reachable at `temporal.address` (default `localhost:7233`, override with `DURAFLOW_TEMPORAL_ADDRESS`) to actually run workflows — the server still starts and serves the API without it, and the worker pool keeps retrying until Temporal answers. Go 1.27.1+ (zigflow v0.18's minimum).

Tests: `go test ./...` (`-cover` for per-package figures). Every package has tests and none needs Temporal or Postgres by default:

- `internal/temporalexec/temporaltest` is an in-memory `client.Client` covering exactly the calls this backend makes (describe, history, execute, get-result, terminate, delete-history, schedule list/create/delete); anything else panics, so a new call site shows up as a failing test. Inject it with `temporalexec.NewStaticClient(fake)`. `Gate` holds every workflow result until closed — that's how a test keeps a run "running". It records the DSL hash each start and schedule was pinned to (`Started.Hash`, `CreatedSchedule.Hash`), since the fake skips context propagators.
- `internal/api/harness_test.go`'s `newTestEnv` serves the whole router (auth middleware included) over `httptest` against a temp-file SQLite DB and that fake, compiling DSLs with the real zigflow library; `newTestEnvWith(t, temporalexec.NewLazyClient("127.0.0.1:1"))` gives the "Temporal is down" variant. `testDSL` builds a minimal DSL zigflow accepts (zigflow v0.18 rejects the legacy `document.name`/`namespace` keys, and a `schedule:` needs `metadata.scheduleWorkflowName`). Give executions fresh ids (`seedExecution` does) — `watchTerminal` de-duplicates through a package-level map shared by all tests.
- `internal/e2e` runs the real worker pool against a real Temporal when `DURAFLOW_E2E_TEMPORAL` is set (e.g. `temporal server start-dev --headless --port 7299`): fork children, HTTP activities, version pinning across saves, `run: workflow` across stored workflows, failover to a fresh pool process, schedules. With `DURAFLOW_TEST_POSTGRES` also set, `TestScaledOutDeployment` runs two api and two worker copies (`internal/app`) on one Postgres schema. `internal/coord`'s Postgres tests use `DURAFLOW_TEST_POSTGRES` too.

## Architecture

```
cmd/server/main.go        # config → app.New → app.Run, until SIGINT/SIGTERM
internal/
  app/                    # wires one process for its roles: db + migrations (under a startup lock),
                          # coordination, Temporal client, DSL cache, event bus, resolver, worker pool,
                          # jobs leader election, HTTP server. Tests start several Apps side by side.
  config/config.go        # viper loader — defaults in Load(); roles, worker pool and telemetry settings
  db/db.go                # Connect + Migrate (AutoMigrate); Open = both, for tests
  models/                 # GORM models: User, Project, Workflow, DSLVersion, WorkflowRegistration,
                          # Execution, ExecutionEvent, WorkflowExecutionRef, Worker
  auth/                   # bcrypt hashing, JWT issue/verify (enforcement is Huma-level, see api/router.go)
  dslhash/                # a DSL version's name (SHA-256 of its text) and the Temporal context propagator
                          # that carries it on every run, child, activity and schedule — a leaf package
  dslruntime/             # zigflow as a library: Compile (validate + build into a capture worker),
                          # Cache (builds by hash, loaded from dsl_versions on a miss), Dispatcher (one
                          # dynamic workflow + one dynamic activity handler), Pool (one Temporal worker
                          # per task queue, heartbeats to the workers table), CloudEvents config
  coord/                  # cross-copy coordination: Notifier (Postgres LISTEN/NOTIFY), Elector (advisory
                          # lock), Locker (advisory locks) — plus in-memory versions for one SQLite process
  events/                 # Broker (in-process fan-out) and Relay (Broker + Notifier, for many copies)
  temporalexec/           # LazyClient (Temporal client with both propagators) + Resolver (CloudEvent → run)
  api/
    router.go              # builds the Echo instance + Huma API, registers every operation,
                            # and owns the bearer-auth Huma middleware (checks Operation.Security)
    auth.go / projects.go / workflows.go / executions.go / workers.go
                            # one file per resource, each a registerXRoutes(api, deps, base) function
    coordination.go         # WatchExecution / workflowsChanged / forgetRuns: reach other copies, or act
                            # locally when Deps.Notifier is nil
  e2e/                    # end-to-end tests against real Temporal (and Postgres), skipped by default
data/                      # sqlite file (gitignored)
Dockerfile                 # multi-stage: one server binary, every role
```

**Migrations**: `db.Migrate` runs `conn.AutoMigrate(&models.User{}, ...)` on every startup (from `app.New`, under the startup lock so concurrent copies take turns) — that's the entire migration story. There are no versioned migration files. Adding a field to a model is enough; GORM adds the column. Switching to Postgres requires no code changes, just config.

**Auth**: every model embeds `models.Base` (UUID `id` + `createdAt`/`updatedAt`, JSON tags matching the frontend's camelCase TS types in `frontend/src/lib/types/index.ts`). `POST /api/auth/login` is the only unauthenticated `/api/*` route; everything else requires `Authorization: Bearer <jwt>`, enforced in `router.go`'s `authMiddleware` — it inspects `huma.Operation.Security` for the `bearerAuth` scheme rather than gating routes by path, so a new operation is protected by default unless you explicitly omit `Security: authSecurity()`. A default admin (`DURAFLOW_SEEDADMIN_EMAIL`/`DURAFLOW_SEEDADMIN_PASSWORD`, set in `docker-compose.yml`) is created on first boot if the `users` table is empty.

**Adding a new operation**: define the `XInput`/`XOutput` structs (path/query params via struct tags, JSON body under a `Body` field) in the relevant `internal/api/*.go` file, then `huma.Register(api, huma.Operation{...}, handler)` inside that file's `registerXRoutes`. The OpenAPI spec and Scalar docs pick it up automatically — nothing else to update.

**Execution**: nothing is spawned per workflow. A **save** compiles the DSL with zigflow (`dslruntime.Compile` — the same validation `zigflow run --validate` did at startup: schema, load, empty type/queue guards, struct validation, zigflow's builder) and, if it builds, stores it as an immutable `DSLVersion` named by its SHA-256, points `Workflow.CurrentHash` at it, replaces the workflow's `WorkflowRegistration` rows (every Temporal workflow name the DSL registers on its queue: the document's type plus each `do` list zigflow runs as a child), and publishes the schedule. A DSL that doesn't build is still saved (the builder saves drafts mid-edit) but gets no current version, and `Workflow.DSLError` records zigflow's reason; `create-execution` then refuses with 422 and that reason. Saves of one workflow are serialised across copies with `Deps.Locks` (`workflow:<id>`).

`create-execution` starts the workflow with `dslhash.With(ctx, wf.CurrentHash)`, so the client's propagator puts the hash in the start header; the execution row records the `TaskQueue`. The **worker pool** (`dslruntime.Pool`, the `worker` role) runs one Temporal worker per task queue that any saved workflow or any still-running execution uses — not per workflow. Each worker registers zigflow's shared activities statically and one dynamic workflow + one dynamic activity handler (`Dispatcher`). A workflow task's handler reads the run's hash (extracted from the header into the workflow context), gets the build from the `Cache` (compiling it from `dsl_versions` on a miss — hence `worker.deadlockDetectionTimeout` 10s), and calls the zigflow function registered under the task's workflow type, re-stamping the hash into the context so children, activities and continue-as-new carry it. So a run executes the DSL it started on to the end, on any worker, after any number of saves, and a new run picks up a save immediately — no restart, no readiness wait.

Runs without a header (started before versions existed, or by another Temporal client) fall back to the version that currently registers their workflow name on their queue (`Directory`, the in-memory view of `workflow_registrations`), which is how every run behaved under one-process-per-workflow. A `run: workflow` task that starts *another* stored workflow is caught by the Dispatcher's outbound interceptor and started with that workflow's current hash, so the child is pinned too. A version that no longer builds fails the run with a non-retryable error. An unknown workflow type, or a database error, panics the workflow task so Temporal retries it, and an unknown activity name returns a retryable error — exactly what a statically registered worker does, so tasks meant for a user's own worker sharing the queue can still reach it.

`captureWorker` (dslruntime/capture.go) is the `worker.Worker` zigflow's `NewWorkflow` registers into. It must stay a small comparable value: zigflow keeps every `(worker, activity name)` pair in a package-level map it never clears, so keying it by an id-only value leaks bytes per build, not builds.

**Scaling**: `api` copies are stateless — any copy serves any request, including a run's SSE stream (events reach it through `events.Relay`: NOTIFY carries `{executionId, seq}`, each copy with a subscriber loads the row) and CloudEvents ingest. One api copy at a time holds the jobs leader lock (`coord.Elector`): it runs the completion watchers (requests go to it over `coord.ChannelWatch`; it also sweeps `status = 'running'` on election and every 30s) and the resolver's sweep/prune. `worker` copies are stateless too; saves NOTIFY them (`coord.ChannelWorkflows`) to refresh queues at once rather than on their 5s tick. Splitting roles or running several copies requires Postgres (config validation refuses otherwise); a worker-only copy needs `telemetry.sinkURL`. The telemetry token is derived from `auth.jwtSecret` unless set, so copies agree without extra config. Migrations, the admin seed and the DSL-version backfill run under a startup lock.

**Run telemetry (what the UI shows after a run)**: Temporal history alone can't describe a zigflow run — `set`/`switch` leave no correlatable events, and fork branches execute as *separate child workflows* whose activities never appear in the parent's history (since zigflow v0.17 `for`/`try`/`catch` bodies run inline, so their events carry the parent's id). So every build's emitter is pointed (via the process's CloudEvents config file, `dslruntime.WriteCloudEventsConfig`) at the API's ingest endpoint, and zigflow POSTs one CloudEvent per task lifecycle moment — `dev.zigflow.task.started/retried/cancelled/faulted/completed` plus `workflow.started/completed` — each carrying that task's input, output and the workflow state.

- `internal/api/telemetry.go` receives them at `POST /api/internal/zigflow/events` (no `Security:`, authenticated instead by a shared `X-Duraflow-Token`; keep it off the public load balancer — `docker/nginx/nginx.conf` returns 404 for `/api/internal/`). zigflow's emitter is **not replay-guarded** and blocks the running workflow on the HTTP response, so this handler does one indexed insert and nothing else; duplicates from replays are collapsed by a content hash (`dedupeKeyFor`, deliberately excluding the re-stamped CloudEvent time).
- `internal/temporalexec/resolver.go` then works out, on its own goroutine (every api copy resolves what its own ingest received; only the leader runs `RunMaintenance`), which run each event belongs to — walking Temporal's parent chain (never string-parsing ids) and caching the answer in `workflow_execution_refs`. Synthetic `workflow_(for|fork|try|catch)_*` children become a `ScopePath` on the parent's canvas; so does a child whose type matches no stored workflow — that is a switch-`then:` starting a *named workflow* declared in the same document (zigflow registers every `do:` that follows another task as a workflow named by its task key), and since its id (`<parentRunId>_N`) says nothing, its segment is `workflow_<name>` built from the type, which the frontend resolves by name; a real `run: workflow` child gets its own `Execution` row (id = its Temporal workflow id) with `ParentExecutionID`/`ParentTaskName` set, which is what powers the UI's child-run drill-down.
- `internal/events/broker.go` fans resolved events out to watchers. `GET /executions/{id}/watch` replays the stored backlog from `?afterSeq=` then streams live, so a reconnect or a page opened on a finished run sees the identical timeline; `GET /executions/{id}/events` is the same data without a stream.
- Nothing in Temporal pushes "your workflow finished", so `watchTerminal` runs one goroutine per running execution on the jobs leader (requested through `Deps.WatchExecution` by `create-execution`, the SSE handler and child discovery, and re-attached by the leader's sweep over `status = 'running'`). A watcher whose connection breaks (Describe fails with anything but NotFound, or still says running) records nothing and leaves the run to the next sweep to persist the terminal status, output and — new — the failure message on `Execution.Error`. It (and `reconcileStatus`) describes the workflow's *latest* run (empty run id), never `TemporalRunID`: a zigflow workflow with `metadata.canMaxHistoryLength` continues-as-new mid-run, the first run closes as `CONTINUED_AS_NEW`, and describing it left runs stuck at `running`.

**Schedules**: there is no `Schedule` model and no `/schedules` routes — a workflow's recurring trigger lives in its DSL (`schedule:` plus `document.metadata.schedule{WorkflowName,Id,Input}`). A save whose DSL builds calls zigflow's own `UpdateSchedules` (`publishWorkflowSchedule` in `workflows.go`), which deletes the schedule with the matching id and recreates it only if the block is still there. It runs with the version's hash in the context, so the schedule's action carries the header and every scheduled run starts pinned to the version current at save time. A blank DSL retracts the previous schedule; a DSL that doesn't build leaves the last good schedule firing. `internal/api/workflow_schedule.go` handles what `UpdateSchedules` can't see — a **deleted** workflow and a **renamed** schedule id (it only cleans up the id it's about to use). Both delete the stale schedule directly, best-effort. `scheduleIDForDSL` mirrors zigflow's `metadata.GetScheduleInfo` default of `zigflow_<document.workflowType>` — keep the two in step.

**Run types, listing and deletion**: `Execution.Trigger` (column `run_trigger` — `TRIGGER` is an SQL keyword) records what started a run: `manual` (`create-execution` defaults to it) or `scheduled`; `backfill` is reserved. Nothing here *starts* a scheduled run — Temporal does, from the schedule above — so there's no row to create up front: `Resolver.adoptScheduledRun` makes one when the first CloudEvent of such a run arrives, recognising it by Temporal's `TemporalScheduledById` search attribute and matching its workflow type + task queue to a stored workflow. A parentless run without that attribute is still left unresolved rather than invented, since an unrecognised root is more likely to be someone else's workflow on the same namespace. Child runs copy their root's trigger in `Resolver.ensureChildExecution`. `GET /executions` is the cross-project list, filtered by `workflowId`/`projectId`/`trigger`/`status`/`from`/`to` and paged with `limit`/`offset`, returning `{items, total}` with workflow and project names joined in two batched reads. `DELETE /executions/{id}` and `POST /executions/delete` (bulk, all-or-nothing) live in `internal/api/execution_delete.go` and delete a run *tree* completely: child runs, events (including still-unresolved ones matched by Temporal id prefix), `workflow_execution_refs`, the resolver's in-memory cache (`Resolver.Forget`) and — best-effort, in the background — Temporal's history for the root and every child/synthetic workflow. Only root runs can be deleted; a still-running run returns 409 unless `force` is set, in which case it's terminated first. Terminal-status writes go through `persistTerminalResult` (an `UPDATE`, never `Save`) because `Save` upserts and would resurrect a run deleted while its `watchTerminal` goroutine was still waiting on Temporal.

**Deleting workflows and projects** cascades (`internal/api/workflow_delete.go`'s `deleteWorkflowCascade`): a workflow's root runs go through `deleteExecutionTrees` with `force` (in-progress runs are terminated — nothing could start their workflow again), then its registrations and row, then its Temporal schedule (`dropWorkflowSchedule`); worker pools drop the queue once nothing else uses it. `DSLVersion` rows are kept — immutable, content-addressed, possibly shared. `delete-project` runs that per workflow before deleting the project row, so a failure part-way never leaves workflows pointing at a missing project. Child runs a workflow contributed to *another* workflow's run tree are left with that tree. Covered by `workflow_delete_test.go`.

The watch stream dedupes by the set of seqs already sent rather than a high-water mark: the resolver can publish an event after one with a higher seq, and a high-water mark would drop it.

`internal/temporalexec/history.go` is now only what's left of the history approach: `ExtractTaskName` (which DSL task started a child workflow), `MapWorkflowStatus`, `EventTypeIsWorkflowClose`. Don't reconstruct run state from history in parallel with CloudEvents — two sources that disagree is worse than one with known gaps.

**Workers page**: `workers` rows are written by the pool (`Pool.setStatus`: one row per process identity × task queue, heartbeat every `worker.heartbeatInterval`, `offline` on clean stop). `list-workers` reports a row `offline` once it misses three heartbeats and deletes rows silent for 24h. `POST /workers` still lets an outside worker register itself.
