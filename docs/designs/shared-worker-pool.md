# Horizontally scalable Duraflow without per-workflow worker processes

*   **Author:** arunksoman69
*   **Status:** Draft (alternative to the process-per-workflow design in `design_draft.md`)
*   **Date:** 2026-10-24

--------------------------------------------------------------------------------

## Overview

Duraflow lets users build workflows in a browser canvas, save them as Zigflow
DSL, and run them on Temporal. Today every workflow with a DSL gets its own
`zigflow run` OS process, spawned and owned by the backend.

Two designs for scaling this out exist, and this document names them by
what they do:

*   **The process-per-workflow design** (`design_draft.md`) keeps one
    process per workflow and moves the processes onto worker hosts run by an
    agent, with a controller rolling out new DSL versions through Temporal
    Worker Versioning.
*   **The shared-pool design** (this document) drops that shape.

In the shared-pool design, **no workflow has its own process.** zigflow
is used as a Go library (`github.com/zigflow/zigflow/pkg/zigflow`) inside
Duraflow's own binary. A pool of identical, stateless Duraflow worker
processes polls the Duraflow task queues. Each pool process registers one
*dynamic* workflow handler and one *dynamic* activity handler (Temporal Go SDK
`RegisterDynamicWorkflow` / `RegisterDynamicActivity`). When a workflow task
arrives, the handler looks up which DSL version that run is pinned to, builds
it with zigflow's `NewWorkflow` (cached by content hash), and executes it.

The run carries its DSL version with it: Duraflow records a content hash of
the DSL in a Temporal header (and, for runs started without one, in a marker
on the first workflow task). Replays and child workflows read that hash, so a
run always continues on the DSL it started with, while a new run picks up the
newest saved version as soon as the save commits. No worker restarts, no
Worker Versioning, no drain.

The process roles become:

1.  **API** (any number of copies): REST, auth, live run stream, CloudEvents
    ingest, and — new — publishing Temporal schedules directly through
    zigflow's `UpdateSchedules` when a DSL is saved.
2.  **Worker** (any number of copies, any host): the dynamic-handler pool
    described above. Stateless; started and restarted by Docker, systemd or
    Kubernetes like any other service.
3.  **Background jobs** (one active copy, chosen by a Postgres lock, running
    inside an API copy): the once-only jobs that exist today — boot sweeps
    and completion watchers.

All roles stay in one binary, and `docker compose up` runs them in one
process, as today.

**What this removes compared with the process-per-workflow design:** the worker agent, the
controller's rollout logic, Temporal Worker Versioning and its server
requirements, the upstream zigflow `--skip-schedules` flag, the DSL files on
local disk, and the up-to-15-second wait on save. **What it costs:** Duraflow
binds to zigflow's Go package API, which is pre-1.0 and was not designed as a
library for this use, and workflows lose process isolation from each other.

## The Problem

Only the frontend can run as several copies today. The backend's six
single-process assumptions are listed in `design_draft.md` ("The Problem") and
are unchanged here. The root cause behind the first three is that **each
workflow's worker is a child OS process of the backend**:

1.  **Workers die with the backend.** A backend crash, redeploy or host loss
    stops every running workflow at the same time as the API.
2.  **Someone must own and supervise each process.** Two backends would each
    spawn a full set and fight over task queues with different DSL versions.
    A crashed process is never restarted (`manager.go:205`).
3.  **A DSL change means restarting a process.** `zigflow run` has no hot
    reload, so every save kills and respawns a process. With more than one
    copy of that process, old and new DSL serve the same task queue at the same
    time, which causes wrong results or non-determinism failures in replays.
    Every restart also deletes and recreates the workflow's Temporal schedule,
    and an error there makes the process exit.
4.  **Memory grows with the number of workflows**, not with load: 500 stored
    workflows means 500 idle Go processes, each with its own Temporal
    connection and pollers.

The process-per-workflow design answers 1–4 by keeping one process per workflow and adding machinery
around it: an agent per host, a controller with a lock, a build id per save,
Worker Versioning rollouts with drain tracking, and an upstream zigflow change
to stop workers touching schedules. Most of that machinery exists only
because the DSL version is tied to a process. If the DSL version travels with
the run instead, a worker no longer needs to be "for" any particular
workflow, and items 1–4 stop applying.

The ingest coupling stays the same in both models: zigflow's CloudEvents
emitter blocks the workflow until the HTTP response returns, so the ingest
endpoint is on the critical path of every run.

**Proposed solution in one paragraph:** store every saved DSL as an immutable,
content-addressed version. Run workflows on a pool of identical Duraflow
worker processes that embed zigflow and register dynamic handlers. Pin each
run to a DSL hash carried in Temporal headers, so replays and children use
the right version without any worker restart. Publish schedules from the save
request by calling zigflow's library function directly. Keep the Postgres
coordination from the process-per-workflow design (live-event fan-out and a lock for once-only jobs).

## Goals

1.  **No per-workflow processes.** Duraflow never spawns `zigflow run`.
    `internal/temporalexec/manager.go` and the `zigflow` binary dependency are
    removed. The number of worker processes is set by the operator and does not
    depend on the number of workflows.
2.  **Upgrade zigflow to v0.18.0 and use it as a library.** Pin the exact
    module version in `backend/go.mod`. Adapt to its two breaking changes
    (error `instance` is a JSON Pointer, PR #638; every `do` list that runs as
    its own workflow is registered and duplicate names fail at load, PR #637).
    This requires Go 1.27.1 and Temporal Go SDK v1.50.0, which zigflow v0.18.0
    itself requires.
3.  **Save, then Run, uses the new DSL immediately.** A save returns as soon
    as the new version is committed and its schedule is published. There is no
    worker restart and no rollout wait.
4.  **Runs in progress finish on the DSL they started with**, including their
    child workflows, retries, and replays on a different worker process.
5.  **The API scales out**, as in the process-per-workflow design's Goal 3: any copy serves any request,
    including live run streams and CloudEvents, with no sticky sessions.
6.  **Losing any single process or host does not stop workflows** when at
    least two worker processes run on different hosts. Temporal moves the work
    to the remaining workers once task timeouts pass.
7.  **Schedules are published once per save**, by the API copy that handled
    the save, and are never touched by worker starts or restarts.
8.  **No duplicate bookkeeping across copies**, as in the process-per-workflow design's Goal 9.
9.  **Single-host mode stays the default.** `docker compose up` runs API,
    worker and background jobs in one process on SQLite and needs no new
    services.

## Non-Goals

1.  **Process isolation between workflows.** A workflow that uses too much
    memory or CPU affects other workflows on the same worker process. Panics
    are contained by the Temporal SDK (the task fails and is retried), but
    resource use is not. Separate worker pools per task queue are the planned
    way to add isolation if it is needed (see Future Improvements).
    Per-workflow isolation is out of scope.
2.  **Supporting DSL written for a different zigflow version than the one
    linked into Duraflow.** Every worker process runs the same zigflow
    version.
3.  **Autoscaling, a Kubernetes operator, or a Helm chart.** Worker count is
    configuration.
4.  **Running Temporal itself in high-availability mode**, multi-region, or
    multi-namespace deployments.
5.  **Running more than one copy on SQLite.** As in the process-per-workflow design, multi-copy needs
    Postgres; startup refuses multi-copy roles on SQLite.
6.  **Changing the DSL format or the "schedules live in the DSL" rule.**
7.  **Replacing CloudEvents telemetry or the resolver's run-mapping logic.**
    The emitter keeps posting to the ingest endpoint over HTTP.
8.  **Running DSL that was not saved through Duraflow.** Only workflow types
    with a stored DSL version can execute on the pool.

## Open Questions

*   **Stability of zigflow's Go API.** The shared-pool design depends on
    `pkg/zigflow.NewWorkflow`, `pkg/zigflow.UpdateSchedules`,
    `pkg/zigflow.LoadFromBytes`, `pkg/zigflow/tasks.ActivitiesList` and
    `pkg/cloudevents.Load`, and on the fact that zigflow registers everything
    through the `worker.Worker` interface it is given. None of this is
    documented as a library contract. Should we ask upstream to declare these
    a supported API, or accept the risk and guard it with a contract test that
    builds every example DSL on each zigflow upgrade?
*   **Loading a DSL version during replay.** When a worker process sees a run
    whose hash is not in its cache, it must read the DSL from the database
    inside workflow code. The read is deterministic (versions are immutable)
    but it is blocking I/O inside a workflow task, and the SDK's deadlock
    detector fails tasks that block for more than about one second. Build
    time has not been measured. The Technical Plan pre-warms versions and, by
    default, loads on a miss with a plain blocking call. A bounded wait with a
    retry is added only if a benchmark shows that loading and building take
    200 ms or more.
*   **Task queue layout.** Each workflow's DSL names its own
    `document.taskQueue`. The pool can either (a) poll every distinct task
    queue found in stored DSL, adding and removing Temporal worker objects as
    saves change the set, or (b) force all Duraflow workflows onto one task
    queue. Option (a) keeps today's DSL meaning and leaves room for per-queue
    pools later. Option (b) is simpler. Proposed default: (a).
*   **Continue-as-new and the version header.** zigflow continues a workflow
    as new when history gets long (`MaxHistoryLength`). Confirm that context
    propagator headers carry over to the new run in SDK v1.50.0. If they do
    not, the new run falls back to resolving the current version, which would
    switch DSL in the middle of a logical run.
*   **Load targets.** As in the process-per-workflow design: proposed 3 API
    copies, 2 worker processes on 2 hosts, up to 500 stored workflows. These
    figures size the Postgres pool and the worker memory check.
*   **Effect of zigflow PR #637 on the resolver.** Unchanged from the process-per-workflow design.

## Critical User Journeys (CUJs)

### CUJ 1: Edit a workflow and run it straight away

*   **Given**: 3 API copies and 2 worker processes. Workflow W is at version
    hash `h1`, and one run of W is in progress.
*   **When**: The user changes W's DSL and clicks Run. The frontend saves,
    which stores version `h2`, then starts a run.
*   **Then**: The save returns once `h2` is committed and W's schedule is
    published (no worker restart). The new run starts with header
    `h2` and executes on `h2`. The in-progress run keeps replaying `h1` on
    whichever worker picks it up. The run console shows live events whichever
    API copy the browser is connected to.

### CUJ 2: A worker host dies mid-run

*   **Given**: Two worker processes on hosts A and B, and a run of W mid-way
    through an activity on A.
*   **When**: Host A loses power.
*   **Then**: Temporal retries the activity on B after its timeout. B has not
    seen `h1` before, loads it by hash, builds it, and continues the run. The
    run completes on `h1`. No Duraflow component has to notice A is gone.

### CUJ 3: A workflow's code fails badly

*   **Given**: A task in W panics, or W's DSL fails to build in zigflow.
*   **When**: A worker process picks up W's workflow task.
*   **Then**: The Temporal SDK turns the panic into a failed workflow task and
    retries it; other workflows on the same process keep running. A build
    failure for a stored version is reported on the run (and was already
    rejected at save time by the same zigflow validation, so it should only
    happen after a zigflow upgrade).

### CUJ 4: Scheduled workflow changes interval

*   **Given**: W has `schedule: every 1m`.
*   **When**: The user saves a DSL with a 5-minute interval.
*   **Then**: The API copy that handles the save calls zigflow's
    `UpdateSchedules` once, under a per-workflow database lock so two
    concurrent saves cannot race on delete and create. No worker touches the
    schedule. The next scheduled run starts without a header, resolves the
    current version on its first workflow task, and gets one `Execution` row
    with `trigger: scheduled`.

### CUJ 5: Redeploy everything one copy at a time

*   **Given**: A running multi-copy deployment.
*   **When**: The operator rolls out a new Duraflow image one process at a time.
*   **Then**: Workflows keep running. Open runs move between worker processes
    as they restart and replay on their pinned hash. If the new image links a
    newer zigflow, open runs replay on the new zigflow code; this is the same
    risk as upgrading zigflow today and is covered by the upgrade checklist in
    the Technical Plan.

### CUJ 6: Local development is unchanged

*   **Given**: A developer runs `docker compose up` on a fresh clone.
*   **When**: They log in, build a workflow and run it.
*   **Then**: One backend process runs API, worker and background jobs on
    SQLite. No `zigflow` binary is needed in the image. Behaviour matches
    today's, apart from zigflow v0.18.0 changes.

## Technical Plan (Architecture)

### Shape of the system

```text
                    browsers                           Temporal (unchanged)
                       |                               ^   ^          ^
                       v                               |   |          |
             +--------------------+   start run +      |   | poll     | schedules
             |  API copy (1..n)   |---header h -------- +   | tasks    | (UpdateSchedules
             |  REST, SSE, ingest |----------------------------------- +  on save)
             |  save -> versions  |                          |
             +---------+----------+                          |
                       |  ^ CloudEvents (HTTP, blocking)     |
                       |  |                                  |
     LISTEN/NOTIFY     |  |                   +--------------+--------------+
     advisory locks    v  |                   |  Worker copy (1..n)         |
             +--------------------+  read     |  one Temporal worker per    |
             |  Postgres          |<----------|  task queue, each with:     |
             |  workflows         |  versions |   - dynamic workflow        |
             |  dsl_versions      |  by hash  |   - dynamic activity        |
             |  executions/events |           |   - zigflow shared acts     |
             +--------------------+           |  compiled-DSL cache by hash |
                                              +-----------------------------+
```

Every copy is the same `duraflow` binary. A `roles` setting (`api`,
`worker`, `jobs`; default all three) decides what a copy runs. The `jobs`
role is only active in the copy that holds a Postgres advisory lock.

### DSL versions

Each saved DSL becomes an immutable row in a new `dsl_versions` table, keyed
by the SHA-256 of the DSL text. The row also stores the build result: either
"ok" or the zigflow error message. Identical DSL text, for example a copied
workflow, shares one row. `workflows` gets a `current_hash` column that points
at the version a new run should use. Saving a DSL inserts the version if it
is new and moves `current_hash`, in one transaction. Versions are never
updated or deleted in this design (see Future Improvements).

Saving stays permissive, as today: a half-edited DSL that does not parse or
build is still stored, with its error. The Run API refuses to start a run on
a version whose build failed and returns that error (422), instead of today's
behaviour where the worker process silently fails to start.

### Pinning a run to a version

The run's DSL hash travels in a Temporal header named
`duraflow-dsl-version`. Duraflow adds a context propagator next to zigflow's
own propagator. Temporal copies propagator headers onto every child workflow
and activity a run starts, and replays read them from history. A run
therefore resolves to the same hash on every worker, every retry and every
replay.

There are two ways a run gets its hash:

1.  **Started by Duraflow** (Run button, executions page): the API reads
    `current_hash` when it starts the run and sets the header.
2.  **Started without the header** (a Temporal schedule, a `run: workflow`
    call into a different Duraflow workflow, or an external client): the
    dynamic workflow handler's first action is a local activity,
    `duraflow.resolveVersion`. It looks up `current_hash` for the run's task
    queue and workflow type. Temporal records the result as a marker in
    history, so replays get the same answer without querying again. The
    local activity is guarded by
    `workflow.GetVersion(ctx, "duraflow-dsl-pin", DefaultVersion, 1)`.
    Runs that were already open when Duraflow switched from `zigflow run`
    processes to the pool have no such marker in their history.
    `GetVersion` returns `DefaultVersion` for them. Instead of scheduling the
    local activity, which would cause a non-determinism error on replay, they
    then take the workflow's `current_hash` directly without recording it.
    Their guarantee is the same as today's: they stay correct as long as the
    DSL is not edited before they finish.

Inside a run, the dispatcher looks up the Temporal workflow type it was asked
to execute:

*   if the type is registered by the pinned version (the document itself, or
    one of the `do` lists zigflow runs as a child workflow), it runs that;
*   otherwise the type belongs to a different Duraflow workflow, called with
    `run: workflow`. The child resolves its own version through
    `duraflow.resolveVersion` and pins its own descendants to it.

This rule depends only on immutable data, so it gives the same answer on
replay.

**Uniqueness requirement:** case 2 needs (task queue, workflow type) to
identify exactly one workflow. `resolver.go`'s `findWorkflow` currently
accepts duplicates and picks the first one. The shared-pool design makes saves that would
create a duplicate fail with 409. Existing duplicates are reported at
startup, and a header-less run of an ambiguous type fails with a clear error
rather than picking one at random. With today's per-process model,
duplicates also cause nondeterministic behaviour, because both workers poll
the same queue.

### Building a version: the capture registry

zigflow builds a workflow by calling `RegisterWorkflowWithOptions` and
`RegisterActivityWithOptions` on the `worker.Worker` it is given. It
registers the document's main workflow and each `do` list that runs as a
child workflow. It also registers one activity per task, named
`<workflowType>.<taskPath>`, whose function holds that task's configuration.

Duraflow passes `zigflow.NewWorkflow` a **capture registry** instead of a
real Temporal worker. It is a type that satisfies `worker.Worker` and stores
each registration in two maps, workflow name → function and activity name →
function, instead of polling. Any other `worker.Worker` method on it panics,
so a zigflow upgrade that starts calling something new fails loudly in tests.
The result is a **compiled version**: the two maps, plus the parsed document
and its CloudEvents emitter. The emitter comes from `cloudevents.Load`, using
one shared config file that each worker process writes at startup.

zigflow's shared activities (`tasks.ActivitiesList()`) do not depend on any
document. They are registered once, by name, on each real Temporal worker.

### Dispatch on the worker

Each worker process holds one SDK client, built with zigflow's context
propagator plus Duraflow's, and the default data converter as today. It also
holds one Temporal `worker.Worker` per task queue. Each of those workers
registers:

*   **a dynamic workflow** that reads the workflow type name, works out the
    hash (from the header or `resolveVersion`), gets the compiled version,
    decodes the input into zigflow's workflow signature
    `(input any, state *utils.State)`, and calls the stored function;
*   **a dynamic activity** that reads the activity type name and the hash from
    the propagated header, gets the compiled version, decodes the arguments
    into that function's parameter types by reflection, and calls it;
*   **zigflow's shared activities**, by name.

The set of task queues comes from the distinct `task_queue` values across
all `workflows`. Each worker process reconciles that set at startup and when
a save changes it: a Postgres `NOTIFY` on `duraflow_task_queues`, plus a
60-second poll as backup on SQLite and in case a notification is missed.
Creating or stopping one Temporal worker object is in-process and does not
affect other queues.

### Compiled-version cache and cache misses

Compiled versions are cached in each worker process, in a map keyed by hash.
Only one load or build of a given hash runs at a time. The map has no size
limit: memory grows with the number of distinct versions saved since the
process started. The process restarts on deploys, and version garbage
collection is listed under Future Improvements. On a miss, the handler loads
the version and builds it with a plain blocking call.

Workflow code must not block for long, so misses inside workflow code are
kept rare by **pre-warming**. A save sends `NOTIFY duraflow_dsl_version`
with the new hash, and every worker process builds it in the background. On
startup, each worker builds every `current_hash`, plus every version
referenced by a running `Execution`, using the `dsl_hash` column below.

**Gate on build time.** The first step of the implementation is a benchmark
that loads and builds the largest example DSL. If the 99th percentile is
200 ms or more, workflow code stops loading on a miss. It waits up to
300 ms instead, then panics with a "version not ready" error. Temporal
treats that panic as a failed workflow task and retries it, without failing
the workflow, while the load finishes in the background. Below 200 ms,
this extra path is not built.

`executions` gets a `dsl_hash` column. The API sets it for runs it starts.
The resolver fills it for adopted scheduled runs and child runs from the
`resolveVersion` result, which `resolveVersion` also stores in the run's
memo. That makes pre-warming possible and lets the run view show the DSL a
run actually used.

### Save path and schedules

Saving a workflow (`update-workflow`, `create-workflow`) now does the
following, in order:

1.  Parse and build the DSL with the capture registry, record the result, and
    insert the `dsl_versions` row if it is new.
2.  In one transaction, update the `workflows` row, including
    `current_hash`, `workflow_type` and `task_queue`. Reject the save with
    409 if (task queue, workflow type) now clashes with another workflow.
3.  If the save changed the schedule id, delete the old schedule
    (`dropRenamedWorkflowSchedule`, unchanged).
4.  Call `zigflow.UpdateSchedules` while holding a per-workflow advisory lock
    (an in-process mutex on SQLite), so two concurrent saves of the same
    workflow cannot both delete and create the schedule at once. Skip this
    when the build failed.
5.  `NOTIFY` the new hash and any change to the task-queue set.

If step 4 fails, the save still returns 200: the DSL is the source of truth.
The response carries a `scheduleError` field, and the builder shows it next
to the schedule control. The `jobs` role re-runs `UpdateSchedules` for every
workflow each time it takes the lock. That replaces today's "every worker
start republishes" behaviour, which is what repairs schedules after Temporal
data loss. A schedule-started run has no header, so it resolves
`current_hash` on its first workflow task, as described above.

`dropWorkflowSchedule` on delete is unchanged.

### Telemetry

zigflow's emitter still POSTs CloudEvents over HTTP to the ingest endpoint
(`internal/api/telemetry.go`, unchanged apart from the shared token). In
multi-copy mode `telemetry.sinkURL` points at the API load balancer, and
`telemetry.token` must be set in config. Startup refuses a multi-copy
deployment with no token, because each copy would otherwise generate its
own. In single-process mode both defaults stay as they are today, using
loopback and a generated token. The blocking-emitter risk is unchanged: a
slow ingest slows workflows.

### Coordination between copies (Postgres only)

These pieces would be the same in the process-per-workflow design. They are spelled out here because
neither draft has defined them yet.

*   **Live events.** `events.Broker` becomes an interface. The in-memory
    implementation is kept for SQLite. The Postgres implementation publishes
    `NOTIFY duraflow_run_events` with the event's `seq` and `executionId`.
    The payload limit of 8,000 bytes rules out sending the event body. Each
    copy keeps one `LISTEN` connection, loads the row by `seq`, and fans it out
    to its local subscribers.
*   **The `jobs` role, which only the lock holder runs.** It holds a
    session-level `pg_try_advisory_lock`, retried every 5 s, on a dedicated
    connection. The holder runs `backfillWorkflowHeaders`, completion
    watchers for running executions, the resolver's sweep and prune, and the
    schedule republish. Watchers become one leader-side loop: every 10 s it
    starts a watcher for each running execution that has none. That replaces
    the `OnExecutionDiscovered` callback, which only works in the copy that
    happened to resolve the event.
*   **Resolver idempotency.** Every copy keeps resolving the events it
    ingested. Duplicate `Execution` rows for one Temporal run are prevented
    by a partial unique index on `temporal_run_id` (where it is not empty;
    Temporal run ids are UUIDs), and inserts use `ON CONFLICT DO NOTHING`
    followed by a re-read. The
    per-process resolution cache is still correct, because a resolution never
    changes once it is made.
*   **Startup.** `AutoMigrate` and the admin seed run while holding a separate
    advisory lock, so copies starting at the same moment run them one at a
    time.
*   **SQLite guard.** Startup refuses to run any role set other than all three
    in one process when the driver is SQLite.

### Workers page

Temporal already tracks which workers poll each task queue, so Duraflow
stops keeping its own `workers` rows. `GET /workers` calls
`DescribeTaskQueue` for each distinct task queue. It merges the pollers by
their identity (the SDK default, `<pid>@<hostname>`) and returns each
identity's task queues and the most recent `lastAccessTime`. A poller seen
in the last 60 s shows as online. The per-workflow `upsertWorker` calls and
the `register-worker` endpoint are removed. The page shows the pool, not one
row per workflow. The old `workers` table is left in place, unused, because
`AutoMigrate` never drops tables.

### zigflow upgrades

Linking zigflow into the binary means a Duraflow release that bumps zigflow
changes the code that replays open runs. In the process-per-workflow design this risk existed too,
but only for workers restarted after the upgrade. Each zigflow bump
therefore requires two checks:

1.  **Contract test.** It builds every DSL under `example/` and the backend
    test fixtures through the capture registry. It fails if zigflow calls a
    `worker.Worker` method the registry does not support, or if the set of
    registered names changes.
2.  **Replay test.** It replays a set of recorded histories, kept as test
    fixtures, against the new build with the SDK's `WorkflowReplayer`.

### Failure modes

| Failure | Effect | Recovery |
| --- | --- | --- |
| Worker process crashes | Its in-flight tasks time out | Temporal retries on another worker. The process manager (Docker, systemd, Kubernetes) restarts it. |
| Panic in one task | That workflow task or activity fails | Temporal retries it. Other workflows are unaffected. |
| A workflow uses too much memory or CPU | All workflows on that process slow down or crash | No fix in this design. Per-queue pools are a Future Improvement. |
| Version not cached during replay | The workflow task blocks while it loads, or, if the build-time gate applies, fails with "not ready" | Done when the load finishes, or Temporal retries the task. |
| Postgres down | Saves, version resolution and ingest fail | Runs that already have their version cached keep executing. New runs and new versions wait. |
| `jobs` lock holder dies | Watchers, sweeps and schedule republish pause | Another copy takes the lock within 5 s. |
| `UpdateSchedules` fails on save | Schedule is out of date | `scheduleError` shown in the builder. Re-saved on the next lock takeover. |

## Alternatives Considered

The first alternative is the full process-per-workflow design in
`design_draft.md`. The others are smaller variations that came up while
working out the shared-pool design. None of them has its own document.

### Keep one process per workflow, on agent-run hosts (`design_draft.md`)

The design in `design_draft.md`. It keeps one `zigflow run` process per
workflow and moves the processes onto worker hosts, each run by an agent. A
controller elected by lock assigns processes to hosts, and Temporal Worker
Versioning in pinned mode keeps open runs on their build.

*   **Pros**: Each workflow keeps its own process, so a workflow that uses too
    much memory or CPU only affects itself. It uses zigflow only through its
    CLI, which is the interface zigflow supports. Temporal does the version
    pinning, so Duraflow has no dynamic dispatch and no reflection.
*   **Cons**: It adds two new components: the agent, and a controller that
    tracks assignments, rollouts and drains. Each save waits up to 15 s for a
    rollout. It needs the Worker Deployment APIs, which require a minimum
    Temporal server version that has not been confirmed. It is blocked on an
    upstream zigflow flag to stop workers touching schedules. Memory still
    grows with the number of workflows, multiplied by the replica count.
*   **Reason for Rejection**: Most of its complexity exists because the DSL
    version is tied to a process. The shared-pool design ties the version to the run, which
    removes that machinery and the external blocker. The process-per-workflow design remains the
    choice if process isolation per workflow turns out to be a hard
    requirement.

### Per-workflow containers managed by an orchestrator

One Docker container or Kubernetes Deployment per workflow, created by the
backend through the Docker or Kubernetes API. Rollouts could use Temporal's
Worker Controller for Kubernetes.

*   **Pros**: Process isolation, restarts and placement come from a standard
    tool. No custom agent.
*   **Cons**: It needs a container orchestrator, even in local development,
    unless a second code path is kept for that. Per-workflow memory cost is
    higher than the process-per-workflow design, because each workflow has a whole container. Version
    pinning and the schedule race still need Worker Versioning and the
    upstream flag.
*   **Reason for Rejection**: It solves process supervision only, which is the
    smallest part of the problem, and it puts infrastructure requirements on
    every deployment.

### Send the DSL text in each run's input

An interpreter workflow receives the full DSL as part of its input and builds
it at run time. No version table and no version lookup.

*   **Pros**: Each run fully describes itself. Replays need no database.
*   **Cons**: Duraflow does not control how most runs are started. Schedules
    created by `zigflow.UpdateSchedules` pass zigflow's own input. Child
    workflows are started by zigflow with their own inputs. External clients
    start runs by workflow type. None of these would carry the DSL without
    forking zigflow. It would also add the full DSL to the history of every
    run and every child.
*   **Reason for Rejection**: It cannot cover schedule, child or external
    starts without changing zigflow. A header with a hash gives the same
    pinning at a fraction of the size.

### Embed zigflow, but keep static registration per save

Duraflow links zigflow and registers each workflow normally on an in-process
Temporal worker. A save stops and recreates that in-process worker with the
new definition. No dynamic handlers.

*   **Pros**: There is no capture registry, no reflection and no custom
    header. Memory per workflow is far lower than with separate processes.
*   **Cons**: With more than one worker copy, old and new definitions poll the
    same task queue during a save, which is the same version-mixing problem
    as today. Fixing that brings back Worker Versioning, build ids and drain
    tracking.
*   **Reason for Rejection**: It solves only the memory problem and leaves the
    determinism problem.

### Embed zigflow, with Worker Versioning per DSL hash

One in-process Temporal worker per (task queue, live DSL hash), with build id
= hash and pinned versioning. Temporal routes each run to its build.

*   **Pros**: Temporal does the pinning, using a mechanism it supports.
    Registration stays static, so there is no reflection.
*   **Cons**: Every worker copy must run every live version of every queue.
    That gives queues × live versions × copies pollers, and the number of live
    versions grows during long-running workflows. It still needs the Worker
    Deployment APIs, so the same server-version question as the process-per-workflow design applies,
    plus logic to decide when a version is drained.
*   **Reason for Rejection**: The number of pollers grows with edit history,
    and it keeps the Temporal server dependency. Header pinning has neither
    problem, at the cost of the dispatch code.

### Put every Duraflow workflow on one shared task queue

The pool polls a single queue, and `document.taskQueue` is overwritten at
save.

*   **Pros**: There is no task-queue reconciliation. Each worker copy has
    exactly one Temporal worker.
*   **Cons**: It changes what users wrote in the DSL. It breaks external
    workers or clients that rely on the DSL's queue name. It removes the only
    isolation lever the shared-pool design has: separate pools per queue.
*   **Reason for Rejection**: Reconciling a small set of queues is cheap, and
    giving up the user's queue name loses more than that saves.

### Record the version hash in memo or a search attribute

The hash is stored in the run's memo instead of a header.

*   **Pros**: The hash is visible in Temporal's UI and searchable.
*   **Cons**: Memo and search attributes do not propagate to child workflows or
    activities. Activities cannot read memo at all without an extra call.
*   **Reason for Rejection**: Headers propagate everywhere a run goes. Memo is
    still written by `resolveVersion`, but only so that run views can display
    the hash.

### Wait for a supported embedding API in zigflow

Ask upstream for a public function that returns a document's workflow and
activity registrations, in place of Duraflow's capture registry.

*   **Pros**: It removes the shared-pool design's largest risk, which is depending on how
    zigflow happens to call `worker.Worker`.
*   **Cons**: It is an external dependency with an unknown timeline, the same
    kind of blocker the process-per-workflow design has with `--skip-schedules`.
*   **Reason for Rejection**: Not rejected outright. The shared-pool design ships on the
    capture registry, protected by the contract test. The upstream API is
    proposed in parallel, and the capture registry is replaced once it lands
    (see Future Improvements).

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security**: Workers no longer receive the telemetry token through a
    file on local disk. It comes from config, and in multi-copy mode it must
    be set explicitly. `run:` tasks (container, script, shell) still execute
    on worker hosts, with the same permissions as today. Pooling means every
    workflow's `run:` tasks share a host and an OS user, which is no worse than
    today's single host.
*   **Performance**: Memory scales with the number of compiled versions in the
    cache, not with the number of stored workflows. Build time per version is
    measured as the first step of the implementation (see "Compiled-version
    cache and cache misses"). Ingest latency is unchanged and remains on the
    critical path of every task.
*   **Rollout and rollback**:
    *   Existing workflows are migrated at first boot: each workflow's DSL is
        inserted into `dsl_versions` and `current_hash` is set.
    *   Runs that are still open at the cutover are handled by the
        `GetVersion` guard described in "Pinning a run to a version". The
        upgrade note recommends not editing a workflow until its open runs
        finish.
    *   The zigflow v0.17.1 → v0.18.0 upgrade ships first, as its own release,
        still on the `zigflow run` CLI, so a replay difference can come from
        only one change at a time.
    *   Rolling back to the subprocess model means deploying the previous
        image. The new tables and columns are additive, so the old code
        ignores them.

### Future Improvements

*   **Version garbage collection**: Delete `dsl_versions` rows that are not
    any workflow's `current_hash` and are not referenced by an open
    execution.
*   **Upstream embedding API**: Replace the capture registry once zigflow
    exposes registrations directly (see "Wait for a supported embedding API in zigflow"
    under Alternatives Considered).
*   **Run view shows the run's own DSL**: Use `executions.dsl_hash` to render
    a past run against the DSL it ran, not the workflow's current DSL.
*   **Per-task-queue worker pools**: A setting that limits a worker copy to
    some task queues, so a resource-heavy workflow can be moved to its own
    pool. Add it when a workflow is observed affecting others.
*   **Cache eviction**: An upper size limit on the compiled-version cache,
    if worker memory grows between deploys in practice.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

The work ships in two releases. **Release 1** upgrades zigflow to v0.18.0
while keeping the `zigflow run` subprocess model, so any replay difference can
only come from zigflow. **Release 2** replaces the subprocess model with the
shared pool. Each release must pass its own verification before the next one
starts.

### Release 1: zigflow v0.18.0 on the existing CLI model

#### 1.1 `backend/Dockerfile` (Modify)

*   **Type / Scope**: Container build.
*   **Proposed Changes**: Change `ARG ZIGFLOW_VERSION` from `v0.17.1` to
    `v0.18.0`. Bump the build stage to a Go 1.27 image, because zigflow
    v0.18.0's `go.mod` requires Go 1.27.1.

#### 1.2 `CONTRIBUTING.md` (Modify)

*   **Type / Scope**: Contributor docs.
*   **Proposed Changes**: Change the `git clone --branch v0.17.1` line to
    `v0.18.0`, and state Go 1.27.1 as the minimum.

#### 1.3 `frontend/src/lib/zigflow-engine/schema/zigflow.schema.json` (Modify)

*   **Type / Scope**: Vendored DSL schema.
*   **Proposed Changes**: Replace the file with `schema.json` from zigflow
    v0.18.0, so the builder validates against the runtime it will run on.

#### 1.4 `frontend/src/lib/zigflow-engine/validate.ts` and `validate.test.ts` (Modify)

*   **Type / Scope**: Builder validation.
*   **Proposed Changes**: Add a validation error when two `do` lists that
    zigflow registers as workflows end up with the same name. This mirrors
    zigflow PR #637's `claimWorkflowName` check, which now fails at load. The
    test covers two named workflows with the same key at different depths.

#### 1.5 `website/content/docs/getting-started/installation.mdx` (Modify)

*   **Type / Scope**: User docs.
*   **Proposed Changes**: Change the zigflow version pin to v0.18.0.

### Release 2: the shared pool

#### 2.1 `backend/go.mod`, `backend/go.sum` (Modify)

*   **Type / Scope**: Go module.
*   **Proposed Changes**: Change `go 1.26.3` to `go 1.27.1`. Add
    `github.com/zigflow/zigflow v0.18.0` as a direct dependency. Bump
    `go.temporal.io/sdk` to `v1.50.0`. Add `golang.org/x/sync` for
    `singleflight`. Copy zigflow's
    `replace k8s.io/kube-openapi => k8s.io/kube-openapi v0.0.0-20260821135717-be32def86098`
    into `backend/go.mod`. Go ignores `replace` directives in dependencies, and
    zigflow does not build without this one.

#### 2.2 `backend/internal/dslruntime/registry.go` (Create)

*   **Type / Scope**: Go package, the capture registry.
*   **Proposed Changes**: A `captureRegistry` type that satisfies
    `worker.Worker` by embedding a nil `worker.Worker`. The methods it
    implements are:
    *   `RegisterWorkflowWithOptions(fn, opts)` stores `opts.Name → fn`.
    *   `RegisterActivityWithOptions(fn, opts)` stores `opts.Name → fn`.
    *   `RegisterWorkflow` and `RegisterActivity` (without options) store
        under the function's reflected name.

    Every other method panics with
    `"dslruntime: zigflow called unsupported worker method <name>"`. Exported
    result type:
    `Registrations { Workflows map[string]any; Activities map[string]any }`.

#### 2.3 `backend/internal/dslruntime/version.go` (Create)

*   **Type / Scope**: Go package, hashing and building.
*   **Proposed Changes**: Three exported pieces:
    *   `Hash(dsl string) string`: lowercase hex SHA-256 of the exact DSL
        bytes.
    *   `type Compiled struct { Hash string; Doc *model.Workflow; Reg Registrations }`.
    *   `Build(hash, dsl string, env BuildEnv) (*Compiled, error)`, which
        runs `zigflow.LoadFromBytes`, then
        `cloudevents.Load(env.CloudEventsConfigPath, validator, doc)`, then
        `zigflow.NewWorkflow(captureRegistry, doc, env.Envvars, emitter, nil, &tasks.TaskOpts{})`.
        It recovers any panic from zigflow and returns it as an error.

    `BuildEnv` holds the envvars, loaded once with `utils.LoadEnvvars`
    and the configured prefix, and the path of the shared CloudEvents config
    file. Telemetry is `nil`, because Duraflow does not use zigflow's usage
    telemetry.

#### 2.4 `backend/internal/dslruntime/cache.go` (Create)

*   **Type / Scope**: Go package, the compiled-version cache.
*   **Proposed Changes**: `Cache` is a `sync.Map` keyed by hash, with no size
    limit. It uses `singleflight.Group`, so only one load runs per hash.
    Methods:
    *   `Get(ctx, hash) (*Compiled, error)`: a blocking call, used
        everywhere.
    *   `Prewarm(hashes []string)`: builds in the background.

    It loads DSL text through a `VersionStore` interface,
    `Load(ctx, hash) (dsl string, err error)`, which reads `dsl_versions`.
    It also adds `version_bench_test.go`, which benchmarks `Load` and `Build`
    on the largest file in `example/`. **This is written first.** If its 99th
    percentile is 200 ms or more, `Cache` also gets
    `TryGet(hash, wait) (*Compiled, bool)`, and 2.6 uses it as described
    there.

#### 2.5 `backend/internal/dslruntime/propagator.go` (Create)

*   **Type / Scope**: Go package, the Temporal context propagator.
*   **Proposed Changes**: A `workflow.ContextPropagator` that writes and
    reads the header `duraflow-dsl-version`. Its value is the hash, encoded
    with the default data converter. Helpers:
    *   `WithHash(ctx context.Context, hash) context.Context`
    *   `HashFromContext(ctx context.Context) string`
    *   `WithWorkflowHash(ctx workflow.Context, hash) workflow.Context`
    *   `HashFromWorkflow(ctx workflow.Context) string`

#### 2.6 `backend/internal/dslruntime/dispatch.go` (Create)

*   **Type / Scope**: Go package, the dynamic handlers.
*   **Proposed Changes**:
    *   `DynamicWorkflow(ctx workflow.Context, args converter.EncodedValues) (any, error)`.
        It reads `name := workflow.GetInfo(ctx).WorkflowType.Name` and
        `hash := HashFromWorkflow(ctx)`, then checks:
        1.  If `hash` is not empty, call `Cache.Get(hash)`. Only if the
            build-time gate in 2.4 applies, call `TryGet(hash, 300ms)`
            instead, and panic with `ErrVersionNotReady` on a miss. If `name`
            is in
            `Reg.Workflows`, use that entry. Otherwise, set `hash` to empty
            (a `run: workflow` into another Duraflow workflow).
        2.  If `hash` is empty, call
            `v := workflow.GetVersion(ctx, "duraflow-dsl-pin", workflow.DefaultVersion, 1)`.
            If `v == 1`, run the local activity `duraflow.resolveVersion`
            with input (task queue, name). It returns the hash, upserts memo
            `duraflowDslHash`, and warms the cache. If
            `v == DefaultVersion`, the run was open before the cutover:
            query `current_hash` directly and do not record it.
        3.  Set `ctx = WithWorkflowHash(ctx, hash)`, then decode `args` into
            `(input any, state *utils.State)` and call
            `fn.(tasks.TemporalWorkflowFunc)`.
    *   `DynamicActivity(ctx context.Context, args converter.EncodedValues) (any, error)`.
        It reads the activity type name and `HashFromContext(ctx)`, runs
        `Cache.Get`, and looks the name up in `Reg.Activities`. It decodes
        `args` into the function's parameter types by reflection and calls
        it. An unknown name or a missing hash returns a non-retryable
        application error.
    *   `ResolveVersion(ctx, taskQueue, workflowType) (string, error)`.
        This is the local activity. It reads `workflows.current_hash` for
        exactly one match. With zero or several matches it returns a
        non-retryable error that names the clash.

#### 2.7 `backend/internal/dslruntime/pool.go` (Create)

*   **Type / Scope**: Go package, the worker role.
*   **Proposed Changes**: `Pool` holds the SDK client, built by
    `temporalexec.ClientOptions` (2.15), and
    `map[taskQueue]worker.Worker`. Methods:
    *   `Start(ctx)`: writes the CloudEvents config file once, reconciles the
        task queues, and pre-warms the cache.
    *   `Reconcile(ctx)`: reads `SELECT DISTINCT task_queue FROM workflows WHERE task_queue <> ''`.
        It creates and starts a worker for each new queue (registering `DynamicWorkflow`,
        `DynamicActivity`, `ResolveVersion` as a local activity, and
        `tasks.ActivitiesList()`), and stops workers for queues that are
        gone.
    *   `Stop()`.

    Triggers for `Reconcile`: `NOTIFY duraflow_task_queues`, plus a
    60-second ticker. Triggers for `Prewarm`: `NOTIFY duraflow_dsl_version`
    with the hash.

#### 2.8 `backend/internal/dslruntime/*_test.go` and `testdata/` (Create)

*   **Type / Scope**: Unit, contract and replay tests.
*   **Proposed Changes**:
    *   `registry_test.go`: an unsupported method panics with the method
        name.
    *   `cache_test.go`: one load per hash under concurrent `Get`; `Prewarm`
        fills the cache. If `TryGet` is built, it times out and later finds
        the entry.
    *   `dispatch_test.go`: uses `testsuite.WorkflowTestSuite`, and covers:
        *   a header run executes the pinned version after the current hash
            has moved;
        *   a header-less run records the `resolveVersion` marker and
            resolves the same hash on replay;
        *   a `run: workflow` child resolves its own document;
        *   a `for`, `fork` or `try` child uses the parent's version;
        *   a cache miss loads and the run completes. If the gate applies,
            the miss panics with not-ready instead and the retry succeeds;
        *   an ambiguous (task queue, type) fails with the clash message.
    *   `contract_test.go`: builds every file in `example/*.yaml` and
        `testdata/dsl/*.yaml`, and compares the registered workflow and
        activity names with golden files in `testdata/golden/`.
    *   `replay_test.go`: runs `worker.NewWorkflowReplayer` with
        `DynamicWorkflow` over `testdata/histories/*.json`. These are
        histories recorded from `zigflow run` v0.18.0 workers in Release 1
        (needed for the cutover guard) and from the pool.

#### 2.9 `backend/internal/coord/lock.go`, `notify.go`, `coord_test.go` (Create)

*   **Type / Scope**: Go package, Postgres coordination with SQLite
    fallbacks.
*   **Proposed Changes**:
    *   `lock.go`:
        *   `Leader` holds `pg_try_advisory_lock(<constant>)` on a dedicated
            `pgx` connection and retries every 5 s. It exposes
            `IsLeader() bool` and `OnAcquire(func(ctx))`. On SQLite it is
            always the leader.
        *   `WithWorkflowLock(ctx, tx, workflowID, fn)` takes
            `pg_advisory_xact_lock(hashtext(workflowID))`. On SQLite it uses
            an in-process keyed mutex.
        *   `WithStartupLock` does the same for migrations and the admin
            seed.
    *   `notify.go`: `Notifier.Publish(channel, payload)` and
        `Subscribe(channel) <-chan string`. They run over one `LISTEN`
        connection and reconnect with backoff. On SQLite it is an in-process
        fan-out.
    *   Tests run against both drivers. Postgres runs in the CI service
        container, and those tests are skipped when `DURAFLOW_TEST_PG_DSN`
        is unset.

#### 2.10 `backend/internal/events/broker.go`, `broker_test.go` (Modify), `pgbroker.go` (Create)

*   **Type / Scope**: Live run-event fan-out.
*   **Proposed Changes**: Extract the `Bus` interface (`Subscribe`,
    `Publish`) from the current `Broker`, which stays as the in-memory
    implementation. `pgbroker.go` wraps a local `Broker`:
    *   `Publish` sends `NOTIFY duraflow_run_events` with
        `{"seq":…,"executionId":…}`.
    *   A listener goroutine loads each notified event by `seq` and calls the
        local `Broker.Publish`.

    Tests cover delivery between two `PGBroker` instances on one database.

#### 2.11 `backend/internal/models/dsl_version.go` (Create)

*   **Type / Scope**: GORM model.
*   **Proposed Changes**: `DSLVersion` has these fields:
    *   `Hash string`: primary key, 64 characters.
    *   `DSL string`
    *   `BuildError string`: empty means the build succeeded.
    *   `ZigflowVersion string`
    *   `CreatedAt time.Time`

    Rows are never updated.

#### 2.12 `backend/internal/models/workflow.go`, `execution.go`, `worker.go` (Modify)

*   **Type / Scope**: GORM models and DTOs.
*   **Proposed Changes**:
    *   `Workflow` gains `CurrentHash string` (indexed, JSON `currentHash`)
        and `BuildError string` (JSON `buildError`, `gorm:"-"`, filled from
        the version on read).
    *   `Execution` gains `DSLHash string` (JSON `dslHash`).
    *   `Worker` stops being a GORM model and becomes a plain response type:
        *   `Identity`
        *   `TaskQueues []string`
        *   `LastAccessTime time.Time`
        *   `Status`: `online` if seen in the last 60 s, otherwise
            `offline`; `draining` is removed.

        It is removed from `AutoMigrate`, and the old table is left unused.

#### 2.13 `backend/internal/db/db.go` (Modify)

*   **Type / Scope**: Database bootstrap.
*   **Proposed Changes**: Run `AutoMigrate` inside `coord.WithStartupLock`,
    and add `DSLVersion` to it. Add a partial unique index
    `executions(temporal_run_id) WHERE temporal_run_id <> ''`. Add a one-time
    backfill: for every workflow with a DSL and an empty `current_hash`,
    insert its `dsl_versions` row (build result included) and set
    `current_hash`. Add the SQLite guard: return an error if the driver is
    SQLite and `roles` is not all three.

#### 2.14 `backend/internal/config/config.go` (Modify)

*   **Type / Scope**: Config.
*   **Proposed Changes**:
    *   Remove `Temporal.ZigflowBinary` and `Temporal.WorkflowsDir`.
    *   Add:
        *   `Roles []string` (default `["api","worker","jobs"]`, env
            `DURAFLOW_ROLES`)
        *   `Worker.EnvPrefix string` (zigflow's default prefix)
    *   Validation: if `Roles` is not all three and `Telemetry.Token` is
        empty, return an error.

#### 2.15 `backend/internal/temporalexec/client.go`, `client_test.go` (Modify)

*   **Type / Scope**: Temporal client.
*   **Proposed Changes**: Add `ClientOptions(address) client.Options`. It
    sets `ContextPropagators` to zigflow's `ctxpropagator.NewContextPropagator()`
    plus `dslruntime`'s propagator, so the API's run starts carry the header.
    The pool uses the same options. `LazyClient.Get` dials with them.

#### 2.16 `backend/internal/temporalexec/manager.go`, `manager_test.go` (Delete)

*   **Type / Scope**: Subprocess worker manager.
*   **Proposed Changes**: Delete both files. Everything they do is replaced
    by `dslruntime.Pool`.

#### 2.17 `backend/internal/temporalexec/resolver.go`, `resolver_test.go`, `temporaltest/fake.go` (Modify)

*   **Type / Scope**: Telemetry resolver.
*   **Proposed Changes**:
    *   `findWorkflow` returns not-found when more than one workflow matches,
        and logs the clash, instead of returning `matches[0]`.
    *   `adoptScheduledRun` and `ensureChildExecution`:
        *   insert with `ON CONFLICT (temporal_run_id) DO NOTHING`, then
            re-read;
        *   fill `DSLHash` from the run's `duraflowDslHash` memo, read from
            the describe call they already make.
    *   Remove the `OnExecutionDiscovered` field. The leader watcher loop
        (2.21) covers that case.
    *   `fake.go` returns a memo in its describe response.
    *   Tests: a duplicate adoption from two resolvers produces one row; the
        memo hash is copied; an ambiguous type is not adopted.

#### 2.18 `backend/internal/api/workflows.go` (Modify)

*   **Type / Scope**: Workflow CRUD.
*   **Proposed Changes**:
    *   Remove `syncWorkerRegistration` and `stopWorkerRegistration`.
    *   Create and update follow the save path in the Technical Plan:
        1.  hash, then `Cache.Get`-or-build, then insert the `dsl_versions`
            row if it is new;
        2.  in one transaction, check (task queue, type) uniqueness (409
            `"workflow type <t> on task queue <q> is already used by workflow <name>"`)
            and save `current_hash`;
        3.  `dropRenamedWorkflowSchedule`;
        4.  `publishWorkflowSchedule` (2.19), skipped if the build failed;
        5.  `NOTIFY` the hash and, if `task_queue` changed, the queue set.
    *   The response body adds `buildError` and `scheduleError`.

#### 2.19 `backend/internal/api/workflow_schedule.go`, `workflow_schedule_test.go` (Modify)

*   **Type / Scope**: Schedules.
*   **Proposed Changes**:
    *   Add `publishWorkflowSchedule(ctx, deps, workflowID, compiled) error`.
        It calls `zigflow.UpdateSchedules(ctx, temporalClient, compiled.Doc, envvars)`
        inside `coord.WithWorkflowLock`.
    *   Add `republishAllSchedules(ctx, deps)`, which the leader runs on each
        lock acquisition.
    *   Rewrite the file's header comment: schedules are now published by the
        save, not by worker start.
    *   Keep `scheduleIDForDSL`, `dropWorkflowSchedule` and
        `dropRenamedWorkflowSchedule`.
    *   Tests:
        *   publishing runs once per save;
        *   two concurrent saves of one workflow run one after the other;
        *   a failed build skips publishing;
        *   republish covers every scheduled workflow.

#### 2.20 `backend/internal/api/workflow_delete.go`, `workflow_delete_test.go` (Modify)

*   **Type / Scope**: Workflow delete.
*   **Proposed Changes**:
    *   Remove `removeWorkerRegistration` and its `deps.Workers.Stop` call.
        Workers-page rows are no longer per workflow.
    *   After the delete, `NOTIFY duraflow_task_queues`.
    *   The comments that mention worker processes and DSL files are
        rewritten.

#### 2.21 `backend/internal/api/executions.go`, `executions_test.go` (Modify)

*   **Type / Scope**: Run start and completion watching.
*   **Proposed Changes**:
    *   `create-execution`:
        *   load the workflow's `current_hash` version; if `BuildError` is
            set, return 422 with that error;
        *   start the workflow with `dslruntime.WithHash(ctx, hash)`;
        *   set `Execution.DSLHash`;
        *   replace the 502 message "is a zigflow worker running…" with
            "no Duraflow worker is polling task queue <q>". Check the queue's
            pollers with `DescribeTaskQueue` only when the start fails.
    *   `watchTerminal`'s status write gets `WHERE status = 'running'`, so
        watchers on two copies cannot overwrite each other.
    *   Add `RunWatcherLoop(ctx, deps)`: every 10 s on the leader, it calls
        `WatchExecutionUntilClosed` for each running execution not in
        `terminalWatches`.
    *   Tests cover the 422 on a failed build, the header being set, and the
        guarded status write.

#### 2.22 `backend/internal/api/workers.go` (Modify)

*   **Type / Scope**: Workers API.
*   **Proposed Changes**:
    *   `GET /workers` calls `DescribeTaskQueue` (workflow and activity task
        types) for each distinct `workflows.task_queue`. It merges the pollers
        by identity and returns `[]models.Worker`. If Temporal cannot be
        reached, it returns 502.
    *   Remove `POST /workers` (`register-worker`) and `upsertWorker`.
    *   Test: with a fake that reports two pollers on two queues, the
        endpoint returns two workers with merged queues and the right
        status.

#### 2.23 `backend/internal/api/router.go`, `telemetry.go`, `harness_test.go`, `resources_test.go`, `auth_test.go`, `telemetry_test.go` (Modify)

*   **Type / Scope**: Wiring and tests.
*   **Proposed Changes**:
    *   `Deps`:
        *   drops `Workers`;
        *   adds `Versions *dslruntime.Cache`, `Coord` (leader, notifier and
            locks) and `BuildEnv`;
        *   changes `Bus` to the `events.Bus` interface.
    *   `telemetry.go`: only its comments change. They now say "each Duraflow
        worker copy", not "each spawned `zigflow run`".
    *   The test harness builds `Deps` without a `WorkerManager`, with an
        in-memory `Bus`, a SQLite coordinator and a real `dslruntime.Cache`.

#### 2.24 `backend/cmd/server/main.go`, `main_test.go` (Modify)

*   **Type / Scope**: Process entry point.
*   **Proposed Changes**:
    *   Read `Roles`, then build the coordinator, the bus (`PGBroker` on
        Postgres, `Broker` on SQLite) and the cache.
    *   `api` role: start the router and the resolver.
    *   `worker` role: start `dslruntime.Pool`.
    *   `jobs` role: register `OnAcquire`, which runs
        `backfillWorkflowHeaders`, `republishAllSchedules`,
        `RunWatcherLoop`, and the resolver's sweep and prune. Move sweep and
        prune out of `Resolver.Run` behind a leader check.
    *   Remove `startWorkflowWorkers` and `resumeRunningExecutions`; the
        watcher loop replaces the latter.
    *   `seedAdmin` runs under `WithStartupLock`.
    *   Tests cover role parsing and the SQLite guard.

#### 2.25 `docker-compose.yml` (Modify) and `docker/compose.multi.yml` (Create)

*   **Type / Scope**: Local and verification deployments.
*   **Proposed Changes**:
    *   `docker-compose.yml` keeps one backend service with the default
        roles. Any zigflow-binary or workflows-dir variables are removed.
    *   `docker/compose.multi.yml` is an override for verification only. It
        adds Postgres and runs:
        *   three `api,jobs` copies behind an nginx container;
        *   two `worker` copies;
        *   a fixed `DURAFLOW_TELEMETRY_TOKEN`;
        *   `DURAFLOW_TELEMETRY_SINKURL` pointing at nginx.

#### 2.26 `.github/workflows/ci.yml` (Modify)

*   **Type / Scope**: CI.
*   **Proposed Changes**:
    *   Add a Postgres service container to the backend job, and set
        `DURAFLOW_TEST_PG_DSN`.
    *   Remove any zigflow install step.
    *   Add an `e2e-multi` job that runs `docker compose -f docker-compose.yml -f docker/compose.multi.yml up`
        and the multi-copy Playwright spec (2.29).
    *   Update the comment at line 152.

#### 2.27 `frontend/src/lib/types/index.ts`, `src/lib/server/workflows.ts`, `src/lib/server/workers.ts` (Modify)

*   **Type / Scope**: Frontend domain types and API wrappers.
*   **Proposed Changes**:
    *   `Workflow` gains `workflowType`, `taskQueue` (already sent by the
        backend but missing here), `currentHash`, `buildError?` and
        `scheduleError?`.
    *   `Execution` gains `dslHash?`.
    *   `Worker` becomes `{ identity, taskQueues: string[], lastAccessTime, status: 'online' | 'offline' }`.
    *   `updateWorkflow` returns the response body. A 409 response maps to a
        `WorkflowsApiError` that carries the message.

#### 2.28 Builder and Workers page (Modify)

*   **Files**:
    *   `frontend/src/routes/(app)/projects/[projectId]/workflows/[workflowId]/builder/+page.server.ts`
    *   `.../builder/+page.svelte`
    *   `frontend/src/lib/components/builder/ScheduleModal.svelte`
    *   `frontend/src/routes/(app)/workers/+page.svelte`
    *   `frontend/src/routes/(app)/workers/+page.server.ts`
*   **Type / Scope**: UI.
*   **Proposed Changes**:
    *   `save` and `run` return `scheduleError` and `buildError`, and pass
        409 and 422 through as `fail(409|422, { error })` instead of 502.
    *   Remove the run action's comment about "the persisted file".
    *   The builder shows `buildError` in the existing error banner, and
        shows `scheduleError` next to the schedule button.
    *   `ScheduleModal` shows the same error.
    *   The Workers page lists pool copies (identity, task queues, status,
        last seen). Its subtitle is rewritten; it currently says "one per
        workflow with a saved DSL".

#### 2.29 `frontend/e2e/multi-copy.spec.ts` (Create), `frontend/playwright.config.ts` (Modify)

*   **Type / Scope**: End-to-end test.
*   **Proposed Changes**: The spec runs against `compose.multi.yml`:
    1.  Save a workflow, then Run it, and assert the run completes on the new
        version.
    2.  Edit and Run again while the first run waits on a `wait` task.
        Assert the first run finishes with the old output and the second
        with the new.
    3.  Kill one worker container mid-run and assert the run completes.
    4.  Assert the live console receives events while nginx routes the
        browser to a different API copy than the one ingesting.

    `playwright.config.ts` gets its comment updated, and gets a project for
    this spec that runs only when `E2E_MULTI=1`.

#### 2.30 Comment-only frontend updates (Modify)

*   **Files**: `frontend/src/lib/zigflow-engine/ast.ts` (line 265),
    `frontend/src/lib/zigflow-engine/schedule.ts` (line 18).
*   **Proposed Changes**: These comments say "`zigflow run` deletes the
    matching Temporal schedule". Change them to "saving the workflow
    republishes the schedule". No behaviour changes.

#### 2.31 Documentation (Modify)

*   `CLAUDE.md`: the "Schedules are not a resource" and "Run observability"
    paragraphs say schedules are published on save by the API through
    zigflow's library, and that workers are a shared pool.
*   `backend/CLAUDE.md`: replace the section on per-workflow `zigflow run`
    subprocesses with the `dslruntime` design (versions, header pinning,
    capture registry, cache, roles, the zigflow upgrade checklist).
*   `frontend/CLAUDE.md`: the Workers page and the new `Workflow` fields.
*   `README.md`: lines 42 and 49 (the architecture diagram and the "Deploy"
    step) say pool workers, not one process per workflow.
*   `CONTRIBUTING.md`: remove the zigflow CLI prerequisite. Add `roles` and
    the multi-copy compose override.
*   `website/content/docs/architecture/index.mdx`, `architecture/execution.mdx`,
    `architecture/observability.mdx`: the new execution model, version
    pinning, and the CloudEvents sink URL in multi-copy mode.
*   `website/content/docs/getting-started/configuration.mdx`: the new keys
    (`roles`, `worker.*`), the removed keys (`temporal.zigflowBinary`,
    `temporal.workflowsDir`), and the telemetry token rule.
*   `website/content/docs/getting-started/installation.mdx`: no zigflow CLI
    is needed.
*   `website/content/docs/guides/workers.mdx`: rewrite for the pool, and
    recapture its screenshot with `website/scripts/capture-screenshots.mjs`.
*   `website/content/docs/guides/schedules.mdx`: publishing on save, the
    `scheduleError` message, and republishing on leader takeover.
*   `website/content/docs/guides/projects-and-workflows.mdx`: lines 33 and 48
    (the save and delete side effects) and the new 409 on a duplicate
    workflow type.

### Verification Plan

*   **Compilation/Build**:
    *   `cd backend && go build ./...`
    *   `docker compose build`
    *   `cd frontend && pnpm build`
    *   `cd website && pnpm build`
*   **Unit Tests**:
    *   `cd backend && go test ./...`, with and without
        `DURAFLOW_TEST_PG_DSN`.
    *   `cd frontend && pnpm test`
*   **Static Analysis & Linting**:
    *   `cd backend && go vet ./...`
    *   `cd frontend && pnpm lint && pnpm check`
*   **Contract and replay**: `go test ./internal/dslruntime -run 'Contract|Replay'`
    passes on Release 2. It also passes on every later zigflow bump before
    merge.
*   **E2E/Integration**:
    *   The existing Playwright suite passes against plain
        `docker compose up` (single process, SQLite).
    *   `E2E_MULTI=1` runs `multi-copy.spec.ts` against
        `compose.multi.yml`.
    *   Manual checks:
        *   a scheduled workflow fires once per interval with three API
            copies;
        *   killing the `jobs` lock holder moves the lock within 5 s;
        *   `docker stats` shows worker memory flat as the number of stored
            workflows grows from 10 to 500.
*   **Release 1 gate**:
    *   The existing suite passes on zigflow v0.18.0.
    *   At least five histories are recorded from v0.18.0 `zigflow run`
        workers (one per example DSL, with at least one `for`, one `fork`,
        one `try` and one scheduled run) and committed to
        `backend/internal/dslruntime/testdata/histories/`.

--------------------------------------------------------------------------------

*Drafted with EGM*
