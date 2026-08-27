# Duraflow

A workflow builder: SvelteKit frontend + Go backend, monorepo.

```
frontend/   SvelteKit app (builder canvas, Zigflow DSL engine) — see frontend/README.md, frontend/CLAUDE.md
backend/    Go API (Huma + Echo, GORM, SQLite/Postgres-ready) — see backend/CLAUDE.md
```

## Quickstart

Run both at once (PowerShell, Windows): `.\dev.ps1` — opens backend + frontend each in their own window. Add `-SameWindow` to run both as background jobs with interleaved output in one window instead.

Or run them separately:

**Backend** (Go 1.22+):

```sh
cd backend
go run ./cmd/server
```

Starts on `http://localhost:8000`. Interactive API docs (Scalar, auto-generated from the code) at `http://localhost:8000/docs`; raw OpenAPI spec at `/openapi.json`. A default admin user is seeded on first boot — see `backend/config/config.yaml`'s `seedAdmin` section for credentials, and change `auth.jwtSecret` before deploying anywhere real.

**Frontend** (Node 20+, pnpm):

```sh
cd frontend
pnpm install
pnpm dev
```

Starts on `http://localhost:5173` and talks to the backend at `http://localhost:8000/api` by default (see `frontend/.env.example` to override via `API_BASE_URL`). Log in with the seeded admin.

## Database

SQLite by default, file at `backend/data/duraflow.db` (gitignored), schema auto-migrated on every backend startup. To switch to Postgres later, set `database.driver: postgres` and `database.dsn: "<connection string>"` in `backend/config/config.yaml` (or the `DURAFLOW_DATABASE_*` env vars) — no code or migration changes needed.
