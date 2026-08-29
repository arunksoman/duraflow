# Duraflow

A workflow builder: SvelteKit frontend + Go backend + Temporal/Zigflow execution, monorepo.

```
frontend/   SvelteKit app (builder canvas, Zigflow DSL engine) — see frontend/README.md, frontend/CLAUDE.md
backend/    Go API (Huma + Echo, GORM, SQLite/Postgres-ready) — see backend/CLAUDE.md
docker/     Supporting images (currently just the Temporal dev server)
```

## Quickstart (Docker)

```sh
docker compose up --build
```

Brings up three services: `temporal` (dev server — web UI at `http://localhost:8233`, gRPC at `localhost:7233`), `backend` (`http://localhost:8000`, docs at `/docs`), and `frontend` (`http://localhost:5173`). The backend's SQLite database and per-workflow DSL files persist on the host at `backend/data/` (bind-mounted). Log in with the seeded admin — see `docker-compose.yml`'s `backend.environment` for credentials and the JWT secret; change both before running this anywhere but a local machine. Accessing the frontend at anything other than `http://localhost:5173` (a different host/port) also needs `frontend.environment.ORIGIN` updated to match, or form submissions fail with a CSRF error.

To rebuild after a dependency change: `docker compose up --build`. To reset the database: stop the stack and delete `backend/data/duraflow.db`.

## Quickstart (without Docker)

Needs Go 1.22+, Node 20+/pnpm, the [Temporal CLI](https://github.com/temporalio/cli/releases) and the [Zigflow CLI](https://github.com/zigflow/zigflow) (`go install github.com/zigflow/zigflow@latest`) on `PATH`.

```sh
temporal server start-dev          # Temporal dev server — localhost:7233, UI at :8233
cd backend && go run ./cmd/server  # localhost:8000, docs at /docs
cd frontend && pnpm install && pnpm dev  # localhost:5173
```

The frontend talks to the backend at `http://localhost:8000/api` by default (see `frontend/.env.example` to override via `API_BASE_URL`); the backend talks to Temporal at `localhost:7233` by default.

## Backend configuration

`backend/internal/config/config.go`'s `Load()` applies, in increasing precedence: built-in defaults → an optional `backend/config/config.yaml` (not present by default — nothing reads it unless you create one) → `DURAFLOW_*` env vars. `docker-compose.yml` sets everything that matters via env vars — there's no config file to keep in sync and no image to rebuild just to change a setting. A YAML key like `seedAdmin.password` becomes env var `DURAFLOW_SEEDADMIN_PASSWORD`; `temporal.address` becomes `DURAFLOW_TEMPORAL_ADDRESS`, etc. (dots → underscores, uppercased). For local `go run` without Docker, either export the `DURAFLOW_*` vars you want to override, or drop a `config/config.yaml` back in.

## Database

SQLite by default, file at `backend/data/duraflow.db` (gitignored), schema auto-migrated on every backend startup. To switch to Postgres later, set `DURAFLOW_DATABASE_DRIVER=postgres` and `DURAFLOW_DATABASE_DSN="<connection string>"` — no code or migration changes needed.
