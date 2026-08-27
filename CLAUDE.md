# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo layout

```
frontend/   SvelteKit app — see frontend/CLAUDE.md
backend/    Go API + Temporal/Zigflow worker management — see backend/CLAUDE.md
docker/     Supporting images (currently just the Temporal dev server)
```

There is no root-level build tooling — each side is developed and run from within its own folder. Read the relevant subfolder's `CLAUDE.md` before making changes there; this file only covers what spans both.

## Running everything

Primary path is Docker: `docker compose up --build` (see root `README.md`). Without Docker, three things need to run: `temporal server start-dev`, `cd backend && go run ./cmd/server`, `cd frontend && pnpm dev` — see `README.md`'s "Quickstart (without Docker)" section for prerequisites (Temporal CLI, Zigflow CLI).

The frontend's `API_BASE_URL` (`frontend/src/lib/server/http.ts`) defaults to `http://localhost:8000/api`, matching the backend's default `port`/`basePath` in `backend/config/config.yaml`; the backend's `temporal.address` defaults to `localhost:7233` — both need overriding via env vars when not running on the same host (Docker Compose does this already). A default admin user is seeded on the backend's first boot (see `backend/config/config.yaml`'s `seedAdmin` section).

## Keeping the two sides in sync

The frontend's domain types (`frontend/src/lib/types/index.ts`) and the backend's GORM models/DTOs (`backend/internal/models`, `backend/internal/api`) are meant to mirror each other field-for-field (camelCase JSON). When changing one, check the other.

The backend exposes full CRUD for every domain type (`auth`, `projects`, `workflows`, `executions`, `schedules`, `workers`), and the frontend now calls all of them — `src/lib/server/*.ts` has one thin wrapper file per resource, and every nav item in `Sidebar.svelte` is wired to a real page. See each subfolder's `CLAUDE.md` for detail, especially `backend/CLAUDE.md`'s notes on how workflow execution actually runs (one `zigflow run` worker subprocess per workflow, managed by the backend, executing against Temporal).

**Known gap**: the Executions page shows a flat run list with input/output inspection, not a timeline/graph visualization or child-workflow drill-down — flagged as a deliberate scope cut when built, not an oversight.
