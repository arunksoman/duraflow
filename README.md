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

`backend/internal/config/config.go`'s `Load()` applies, in increasing precedence: built-in defaults → `backend/config/config.yaml` if present → `DURAFLOW_*` env vars. The env vars are the only thing `docker compose up` sets (see `docker-compose.yml`) — the config file is optional and only really useful for local `go run`, so there's no image to rebuild just to change a setting in Docker. A YAML key like `seedAdmin.password` becomes `DURAFLOW_SEEDADMIN_PASSWORD`; `temporal.address` becomes `DURAFLOW_TEMPORAL_ADDRESS`, etc. (dots → underscores, uppercased).

## Database

SQLite by default, file at `backend/data/duraflow.db` (gitignored), schema auto-migrated on every backend startup. To switch to Postgres later, set `DURAFLOW_DATABASE_DRIVER=postgres` and `DURAFLOW_DATABASE_DSN="<connection string>"` (env vars, or the equivalent keys in `backend/config/config.yaml` for local dev) — no code or migration changes needed.
