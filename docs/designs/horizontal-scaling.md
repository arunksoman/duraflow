# Horizontally scalable backend on zigflow v0.18.0

*   **Author:** arunksoman69
*   **Status:** Implemented on `feat/model-d-worker-pool`
*   **Date:** 2026-10-25
*   **Supersedes:** `shared-worker-pool.md` and an earlier process-per-workflow draft. This
    design keeps the shared-pool direction the design review endorsed and removes most of the
    machinery it found under-specified.

--------------------------------------------------------------------------------

## Summary

The backend is one Go binary with two roles, chosen by `DURAFLOW_ROLES`:

*   **api** — REST, live run streams, CloudEvents ingest, schedule publishing. One api copy at a
    time also holds a Postgres advisory lock and runs the once-only jobs: completion watchers and
    event-log maintenance.
*   **worker** — a pool of Temporal workers, one per task queue, that runs every saved workflow
    through zigflow v0.18.0 used as a Go library.

Every saved DSL becomes an immutable version named by its SHA-256. Each run carries that hash in
a Temporal header, so every task of the run, on any worker, executes the DSL the run started on.
Saving never restarts anything. Both roles keep no local state, so either scales by adding
copies. The default (`api,worker` in one process, SQLite) is what `docker compose up` runs, and
behaves as before.

## What was wrong

The old backend could not run as more than one copy:

| Single-process assumption | Where | Replaced by |
| --- | --- | --- |
| One `zigflow run` child process per workflow | `temporalexec/manager.go` (deleted) | Worker pool, one Temporal worker per task queue |
| A save restarts the workflow's worker; old and new DSL race on one queue | `Sync` | Content-addressed versions pinned per run |
| Every worker start deletes and recreates its schedule | zigflow `run` | Save publishes once, with zigflow's `UpdateSchedules` |
| Crashed workers stay down | `manager.go` | Stateless pool processes, restarted by the orchestrator; Temporal reassigns their tasks |
| Live events only reach browsers on the receiving process | `events/broker.go` | `events.Relay` over Postgres `LISTEN/NOTIFY` |
| Completion watchers, resolver sweeps, migrations per process | `main.go` | Jobs leader (advisory lock) and a startup lock |
| Per-boot telemetry token, loopback sink, local DSL files | `config.go`, `manager.go` | Token derived from the JWT secret; configurable sink; DSL in the database |

## Options considered

| Option | How it scales | Why not chosen |
| --- | --- | --- |
| **A. Shared worker pool, zigflow as a library (chosen)** | Workers ∝ load, not ∝ workflows. Any worker runs any workflow and version. | — |
| B. Process per workflow on worker hosts, with an agent and a controller (the earlier draft) | Processes ∝ workflows × replicas | Needs an agent, a controller, Worker Versioning rollouts with drain tracking, and an upstream zigflow flag to stop workers touching schedules. Memory and Temporal pollers grow with stored workflows. |
| C. zigflow's Helm chart plus the Temporal Worker Controller, one `WorkerDeployment` per workflow | Kubernetes Deployments ∝ workflows | The chart deploys one workflow file per release. 500 workflows means 500 Deployments, rollouts and sets of pollers, and Kubernetes becomes mandatory. Still has the schedule race. |
| D. Versioned task queue per DSL version (`queue@hash`) with in-process zigflow workers | Temporal workers ∝ workflows × live versions | Avoids dynamic dispatch, but every live version needs its own pollers, and old queues must be drained. Same scaling problem as B, smaller. |

A is the only option where the number of processes and pollers depends on load rather than on
how many workflows are stored. Its cost is binding to zigflow's Go package API, which is pre-1.0.
That binding is three calls (`ValidateBytes`/`LoadFromBytes`, `NewWorkflow`, `UpdateSchedules`)
plus `tasks.ActivitiesList`, and the end-to-end suite catches breakage on upgrade.

## Design

### Save path

1.  `dslruntime.Compile` validates the DSL exactly as `zigflow run --validate` does: JSON Schema,
    load, empty `workflowType`/`taskQueue` guards, struct validation, the CloudEvents emitter, and
    zigflow's builder (which rejects duplicate workflow names, PR #637, and non-deterministic
    expressions). `NewWorkflow` registers into a `captureWorker`, so the build becomes a map of
    workflow and activity functions by name.
2.  In one transaction: insert `dsl_versions(hash, dsl, task_queue, workflow_type)` (no-op if it
    exists), update the workflow row (`current_hash`, `dsl_error`, header columns), and replace its
    `workflow_registrations` (every workflow name the build registers on its queue).
3.  NOTIFY `duraflow_workflows`, so every worker refreshes its queues now.
4.  Publish the schedule with `zigflow.UpdateSchedules`, called with the hash in the context so the
    schedule action carries the header.

A DSL that doesn't build is still saved (the builder saves drafts), with `current_hash = ''` and
zigflow's message in `dsl_error`; a run is then refused with 422 and that message. A blank DSL
retracts the schedule; a DSL that doesn't build leaves the last good schedule running. Saves of
one workflow are serialised across copies with an advisory lock (`workflow:<id>`).

Build results are not stored (review Decision 3, option B): a build is always live, cached in
memory per process, and recompiled from `dsl_versions` on a miss.

### Dispatch

Each pool worker registers zigflow's shared activities statically, plus one dynamic workflow and
one dynamic activity handler.

*   **Workflow task.** Read the hash from the header (`dslhash` propagator) → `Cache.Get(hash)` →
    if the build registers the task's workflow type, call it. Otherwise fall back to the version
    that currently registers that name on that queue (`Directory`, an in-memory view of
    `workflow_registrations`). Arguments decode exactly as for a static registration: one payload
    (input) for API and schedule starts, two (input, state) for children. The handler re-stamps the
    effective hash into the workflow context, so children, activities and continue-as-new carry it.
*   **Activity task.** zigflow's per-task activities are its shared HTTP, gRPC and container
    functions registered under per-task names, so the version only decides which function a name
    maps to. Look it up in the run's build; fall back to the current build of the activity's
    workflow type.
*   **`run: workflow` across stored workflows.** An outbound interceptor sees
    `ExecuteChildWorkflow`; if the parent's build doesn't define the child type, it starts the
    child with the target workflow's current hash. Headers are not part of replay determinism, so
    reading the directory there is safe, and the child is pinned for its whole life.
*   **Errors.** A missing version, or one that no longer builds → non-retryable application
    error (the run fails with a readable message). An unknown workflow type or a database error →
    panic, so Temporal retries the workflow task; an unknown activity name → retryable error.
    Unknown names behave exactly as on a statically registered worker, so tasks for a user's own
    worker on the same queue can still reach it instead of being failed by the pool.

`DeadlockDetectionTimeout` is 10 s, because a cache miss compiles inside the workflow task and
zigflow's emitter blocks the workflow on each CloudEvent POST.

### Child workflows in zigflow v0.18.0

| Construct | Runs as |
| --- | --- |
| `fork` branch | child workflow, same build (header inherited) |
| switch `then:` to a named workflow | child workflow, same build |
| `run: workflow` to the same document | child workflow, same build |
| `run: workflow` to another stored workflow | child workflow, pinned by the interceptor |
| `for`, `try`, `catch` | inline in the parent (since v0.17, already the pinned v0.17.1) |

### Worker pool

`dslruntime.Pool` polls every queue used by a workflow with a current version **or by a running
execution** (`executions.task_queue`), so moving a workflow to another queue or deleting it never
strands an open run (review A7). It refreshes on NOTIFY and every 5 s, pre-builds current versions
in the background, and upserts one `workers` row per (process, queue) every 10 s. The Workers page
shows a row offline after three missed heartbeats.

`captureWorker` is a comparable value holding only an id. zigflow keeps every
`(worker, activity name)` pair in a package-level map it never clears
(`tasks/activity_registration.go`); keying it by an id-only value leaks bytes per build instead of
whole builds (review A1).

### Coordination between copies

`internal/coord` has a Postgres implementation and an in-memory one for the single SQLite process.

| Need | Postgres | Notes |
| --- | --- | --- |
| Live run events on every copy | `LISTEN/NOTIFY` on `duraflow_events`, payload `{executionId, seq}` | A copy with a subscriber loads the row. Unstored markers (terminal) travel whole. On reconnect every stream gets a refetch. |
| Completion watchers once | Leader: `pg_try_advisory_lock` on a dedicated session, pinged every 5 s | Requests arrive on `duraflow_watch`; the leader also sweeps running executions on election and every 30 s. |
| Resolver cache invalidation | `duraflow_forget` | Every copy drops cached resolutions of deleted runs. |
| Save serialisation | `pg_advisory_lock(class, hashtext(key))` on a pinned connection | Two-key form, separate class from the leader lock. |
| One migrator | Startup lock | Migrate, seed admin, backfill versions. |

A watcher that loses its Temporal connection (Describe fails with anything but NotFound, or still
reports running) records nothing; the next leader sweep re-attaches. This fixed a bug the
multi-copy test found: stopping a copy used to mark its watched runs failed with "the client
connection is closing".

### Configuration

| Setting | Rule |
| --- | --- |
| `DURAFLOW_ROLES` | Comma or space separated, `api` and/or `worker`, default both; unknown roles are rejected |
| Split roles | Require `database.driver=postgres` |
| Worker-only process | Requires `telemetry.sinkURL` (an api copy's internal address) |
| `telemetry.token` | Derived from `auth.jwtSecret` unless set, so copies agree |
| `ZIGGY_*` env, `auth.jwtSecret` | Must be identical on every copy |

## Cutover from v0.17.1 process-per-workflow

Review Decision 1 offered "fallbacks" or "drain first". This design needs neither:

*   On first start, `BackfillDSLVersions` (under the startup lock) compiles every stored DSL,
    creates its version and registrations, and republishes its schedule pinned to that version.
*   Runs that were open at cutover have no header. Their workflow tasks and activities resolve by
    name to the current version, which is exactly how they behaved before (a save restarted the
    worker and they continued on the new DSL). Their histories contain no Duraflow markers, so
    there is nothing to be non-deterministic about.

Rollback to the old binary works the same way in reverse, because the new design adds no
commands or markers to histories either: old workers replay new histories without error.

## Release notes for zigflow v0.18.0

*   Go 1.27.1 and Temporal SDK v1.50.0 (zigflow's minimums). `backend/Dockerfile` no longer builds
    the zigflow CLI.
*   PR #637 (every `do` list run as a workflow is registered; duplicate names fail at load):
    surfaced through `dsl_error` on save and the 422 on run.
*   PR #638 (error `instance` is a JSON Pointer): nothing in Duraflow reads `instance`; no change.
*   The docs pages for `for` and `try` said those bodies run as child workflows; corrected (that
    changed in v0.17).

## Verification

| Suite | What it proves | Result |
| --- | --- | --- |
| `go test ./...` | Unit and API behaviour with the in-memory Temporal fake | Pass |
| `internal/e2e` (real Temporal) | Fork children, HTTP activity, task events and scope paths; version pinned across a save; `run: workflow` to another stored workflow; a fresh pool process finishes a run after the first one stops; scheduled runs recorded with `trigger: scheduled` and retracted on delete; eight workflows sharing one pool | Pass |
| `internal/e2e` `TestScaledOutDeployment` (real Temporal + Postgres) | Two api and two worker copies: token from one copy accepted by another; run started on copy B streamed live on copy A; exactly one leader; leader stopped mid-run, the other takes over and records completion; four concurrent saves from different copies give version 5; both workers online | Pass |
| `internal/coord` (Postgres) | NOTIFY reaches every copy; one leader at a time and failover; locks exclude across copies | Pass |
| Frontend `pnpm check`, `pnpm test` | Types and the Workers page wording | Pass |
| Website `pnpm build` | Updated architecture, configuration and guide pages | Pass |

CI runs the integration suites in a new `backend-integration` job.

## Risks

| Risk | Mitigation | Residual |
| --- | --- | --- |
| zigflow's package API changes on upgrade | Small surface; e2e suite in CI | An upgrade may need code changes |
| No process isolation between workflows | Temporal contains panics per task; concurrency caps per queue | A workflow that exhausts memory affects its worker process. Separate pools per task queue are a future option |
| Every worker host needs every runtime any `run:` step uses | Same image everywhere | Same as before |
| Postgres is a single point of failure for coordination and ingest | Runs keep executing in Temporal; zigflow logs an undelivered CloudEvent and carries on after `telemetry.timeout` | Task events emitted during an outage are lost from the run view. Use a highly available Postgres in production |
| Ingest endpoint reachable through the public load balancer | Token auth; nginx config blocks `/api/internal/` | Operators must keep it internal |
| `dsl_versions` grows forever | Rows are small and immutable | Garbage collection of versions no workflow or open run uses is future work |

## Future improvements

*   Garbage-collect unused `dsl_versions`.
*   Per-task-queue worker pools (`worker.taskQueues` allowlist) for isolation and dedicated capacity.
*   Batch completion detection with Temporal visibility queries instead of one long poll per run.
*   Autoscale worker copies on task-queue backlog.
