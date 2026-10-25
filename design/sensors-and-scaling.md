# Sensors and horizontal scaling — findings

Status: research notes, nothing implemented yet. Written 2026-10-22.

Zigflow source references are to **v0.14.3** (the copy in the local Go module cache). The Docker
image pins **v0.17.1** (`backend/Dockerfile`'s `ZIGFLOW_VERSION`), so re-check the cited files
against that tag before building on them.

---

## 1. How workers are created today

Two layers, easy to conflate:

| Layer | Who | What it creates |
|---|---|---|
| OS process | Duraflow backend (`backend/internal/temporalexec/manager.go`, `WorkerManager`) | One `zigflow run` subprocess per workflow with a non-blank DSL |
| Temporal worker | Zigflow (`cmd/run/workers.go`, `buildWorkersByTaskQueue`) | One `worker.Worker` per distinct task queue inside that process |

### Save path (backend)

1. `PATCH /workflows/{id}` (`backend/internal/api/workflows.go`, `update-workflow`) saves the row,
   drops a renamed schedule (`dropRenamedWorkflowSchedule`), then calls `syncWorkerRegistration`.
   `create-workflow` does the same.
2. `syncWorkerRegistration` calls `WorkerManager.Sync` and upserts a `workers` row (status online).
3. `Sync` writes the DSL to `<id>.yaml` (blank DSL → `Stop` instead) and calls `startLocked`.
4. `startLocked` kills any previous process for that workflow, picks free loopback ports for
   metrics and health, writes `<id>.cloudevents.yaml`, and execs:
   ```
   zigflow run -f <id>.yaml --temporal-address <addr>
     --metrics-listen-address 127.0.0.1:<p1>
     --health-listen-address 127.0.0.1:<p2>
     --cloudevents-config <id>.cloudevents.yaml
   ```
5. `Sync` then polls `/readyz` for up to 15s, so the builder's save-then-run doesn't race a worker
   that hasn't registered yet.

Note: `syncWorkerRegistration` runs on *every* update, including name/description-only edits, so
every save restarts the worker (and re-publishes its schedule).

### Inside `zigflow run`

`startInitialWorkers` → `runScheduleUpdates` → `buildWorkersByTaskQueue` → health check →
`startAllWorkers`. `buildWorkersByTaskQueue` creates one worker per distinct task queue (autoscaling
pollers, concurrency limits, optional deployment versioning), registers zigflow's shared activities
once per worker, then registers each DSL as a workflow via `zigflow.NewWorkflow`.

Because Duraflow passes a single `-f`, each process ends up with exactly one Temporal worker.

### Unused zigflow capabilities

- `-f` can be repeated, so one process could serve many workflows.
- `--watch` reloads workers on file change (`cmd/run/watch.go`, "for development use"). The
  backend's CLAUDE.md says zigflow has no hot-reload; that is outdated for these versions. We
  still prefer kill-and-respawn because the readiness wait is easier to reason about.

---

## 2. Sensors (Airflow-style "wait for mail / S3 file / FTP file")

### What zigflow gives us

No IMAP/S3/FTP connectors and no sensor task type. Only the 11 DSL task types. The useful ones:

- `run: script` (python/js), `run: container`, `run: shell` — can perform a check.
- `call: http` — anything with an HTTP API (Gmail API, MS Graph, S3 REST).
- `call: activity` — invokes a named Temporal activity on **any** task queue (`with.taskQueue` is
  required; `pkg/zigflow/tasks/task_builder_call_activity.go`). Retry policy and timeouts come from
  `document.metadata.activityOptions` or the task's own `metadata.activityOptions`
  (`pkg/zigflow/metadata/activity_options.go`).
- `wait` — durable Temporal timer.
- `switch` / task `if` / `then:` — branching and jumps.
- `listen` — Temporal signal/update/query only, not external sources. Default timeout 1m
  (`metadata.timeout`).

### Ways to build a sensor with the DSL alone

1. **Scheduled check (Airflow "reschedule" mode).** `schedule:` every N minutes; each run checks
   once and either proceeds or ends. Simplest; works in the builder today. Needs external state
   for "already processed" (last key, mail UID, `\Seen` flag) because runs don't share state.
2. **In-run poll loop (Airflow "poke" mode).** check → `switch` → `wait` → back to check, via
   `for` + `while` (note `for.in` is required, so loop over a bounded range) or `then:` jumping
   back. Backward `then:` jumps are not verified. Long polls grow history; set
   `metadata.canMaxHistoryLength` (Duraflow already handles continue-as-new).
3. **Push.** S3 Event Notifications / SNS / Lambda, Gmail push via Pub/Sub → Duraflow
   `POST /executions` or a Temporal signal into a `listen` task. FTP has no push.

### Recommended design: sensor activities on a backend-hosted worker

1. **Sensor worker.** The backend runs a Go Temporal worker on its own queue (e.g.
   `duraflow-sensors`) registering `sensor.s3`, `sensor.imap`, `sensor.ftp`, … using native
   clients (aws-sdk-go-v2, an IMAP client, `jlaffaye/ftp`). Each activity checks once: returns the
   new items, or a retryable "not yet" error.
2. **Temporal retry policy is the poke loop.** Retries don't add history events, so no
   continue-as-new, and nothing occupies a slot between checks.
   ```yaml
   - waitForReport:
       call: activity
       with:
         name: sensor.s3
         taskQueue: duraflow-sensors
         arguments: [{ connection: prod-s3, bucket: reports, prefix: daily/, pattern: "*.csv" }]
       metadata:
         activityOptions:
           scheduleToCloseTimeout: 6h      # sensor timeout
           retryPolicy: { initialInterval: 1m, backoffCoefficient: 1, maximumAttempts: 0 }
   ```
   Matched items land in `$data.waitForReport` for downstream tasks.
3. **Builder sensor nodes** (S3 / Mail / FTP) with typed forms (connection, path/filter, interval,
   timeout) that compile to the block above and parse back — the same canvas-only-construct
   approach as the If node.

### New pieces required

- **Connections resource** — `connections` table with encrypted secrets, API, UI page (like Airflow
  Connections). Activities receive a connection *name* and resolve secrets server-side; secrets
  never enter the DSL. Largest piece of work.
- **Dedupe store** — record what each sensor already returned (S3 key + ETag, mail UID, FTP path +
  mtime) so a scheduled sensor doesn't refire on the same items.
- **`call: activity` round-trip** — currently lossy in the builder; must be fixed for sensor nodes.
  Check that CloudEvents from the sensor task show attempt count / "waiting since" on the canvas.
- **Docs** — node pages and a Connections page under `docs/`.

### Later: sensor triggers

A sensor *step* waits inside a run; a sensor *trigger* starts a run when an item arrives (backend
poll or S3/SNS/Gmail push → `create-execution` with the item as input, new `trigger: sensor` value
on `Execution.Trigger`). Following the "schedules are not a resource" rule, declare it in the DSL
(e.g. `document.metadata.trigger`) and have the backend react on save.

### Suggested order

1. Connections + sensor worker, S3 first.
2. S3 sensor node in the builder, with round-trip tests.
3. IMAP, FTP.
4. Dedupe store.
5. Event triggers.

---

## 3. Horizontal scaling

### Zigflow: yes

A `zigflow run` process is an ordinary, stateless Temporal worker. N copies of
`zigflow run -f same.yaml` on N hosts against the same Temporal share the task queue; run state
lives in Temporal history, so a dead replica's runs are replayed elsewhere. Zigflow exposes
autoscaling pollers, concurrency and rate limits (`MaxConcurrentActivityExecutionSize`,
`TaskQueueActivitiesPerSecond`) and Temporal worker versioning (`EnableVersioning`, build ID,
deployment name).

### Caveats with multiple replicas

1. **Schedule race.** Every worker start lists schedules, deletes the matching one and creates it
   again (`pkg/zigflow/schedules.go`) with no "already exists" handling. Replicas starting together
   can fail `Create` fatally (process exits) or delete each other's schedule. Only one process
   should publish schedules.
2. **DSL changes vs. in-flight runs.** During a rolling update, old- and new-DSL replicas serve the
   same workflow type; replaying an in-flight run on a different definition causes
   non-determinism errors. Fix: worker versioning, one build ID per DSL version, runs pinned to the
   version they started on. Duraflow already has this risk with a single worker, since every save
   restarts it on the new DSL while old runs continue.
3. **Telemetry.** Every replica POSTs CloudEvents; dedupe is by content hash so that's safe, but
   the sink URL must be reachable from all replicas.

### Duraflow today: no

- `WorkerManager` spawns child processes on the backend's own host and tracks them in an in-memory
  map. A second backend instance would spawn a duplicate set and hit the schedule race.
- The telemetry sink defaults to loopback on purpose (`backend/internal/config/config.go`) and the
  token is generated per boot, so remote workers couldn't report.
- The Workers page lists processes the backend spawned, not real pollers.

### Possible way to support scaling

- **Worker runner interface** separating "where workers run" from the backend:
  - local runner — today's behaviour;
  - Kubernetes runner — Deployment per workflow with `replicas: N`, DSL in a ConfigMap, optional HPA
    on task-queue backlog.
- **Single schedule publisher** — either a zigflow flag to skip schedules on replicas (would need
  adding upstream, or strip the `schedule:` block from replicas' copy of the DSL), or Duraflow
  publishes schedules itself.
- **Worker versioning** — build ID = workflow version, so in-flight runs finish on the DSL they
  started with.
- **Configurable telemetry** — sink URL and token from config instead of loopback + per-boot token.
- **Workers page from Temporal** — `DescribeTaskQueue` pollers instead of spawned processes.

For a single host, one process per workflow is fine. For production, the Kubernetes runner plus
versioning is the change that matters.
