# CLAUDE.md (backend)

This file provides guidance to Claude Code (claude.ai/code) when working with code in `backend/`. See the root [CLAUDE.md](../CLAUDE.md) for the monorepo overview and [../frontend/CLAUDE.md](../frontend/CLAUDE.md) for the SvelteKit app this serves.

## Project Configuration

- **Language**: Go
- **Web framework**: [Huma v2](https://huma.rocks/) (OpenAPI-first — request/response structs auto-generate the OpenAPI 3.1 spec, no annotations to keep in sync) on top of [Echo](https://echo.labstack.com/) via the `humaecho` adapter
- **ORM**: [GORM](https://gorm.io/) — `AutoMigrate` on every startup, no separate migration tooling
- **Database**: SQLite by default (`github.com/glebarez/sqlite`, pure Go, no CGO); Postgres wired and ready (`gorm.io/driver/postgres`) — flip `database.driver: postgres` + a DSN in config
- **Config**: [viper](https://github.com/spf13/viper), `config/config.yaml` + `DURAFLOW_*` env overrides
- **API docs**: auto-generated OpenAPI 3.1 at `/openapi.json`, rendered with [Scalar](https://scalar.com/) at `/docs`

## Commands

All commands below run from `backend/` (e.g. `cd backend` first, or `go run ./cmd/server` etc. with `-C backend`).

```sh
go run ./cmd/server      # start the server (reads ./config/config.yaml)
go build ./...           # compile everything
go vet ./...             # static checks
go mod tidy              # sync go.mod/go.sum after adding/removing imports
```

There is no test suite yet.

## Architecture

```
cmd/server/main.go        # wiring: config → db (+ seed admin) → router → listen
internal/
  config/config.go        # viper loader — see config/config.yaml for all fields
  db/db.go                # gorm.Open (sqlite|postgres via cfg.Database.Driver) + AutoMigrate
  models/                 # GORM models: User, Project, Workflow, Execution, Schedule, Worker
  auth/                   # bcrypt hashing, JWT issue/verify (enforcement is Huma-level, see api/router.go)
  api/
    router.go              # builds the Echo instance + Huma API, registers every operation,
                            # and owns the bearer-auth Huma middleware (checks Operation.Security)
    auth.go / projects.go / workflows.go / executions.go / schedules.go / workers.go
                            # one file per resource, each a registerXRoutes(api, deps, base) function
config/config.yaml         # defaults: port 8000, basePath /api, sqlite ./data/duraflow.db, seed admin
data/                      # sqlite file lives here (gitignored)
```

**Migrations**: `db.Open` runs `conn.AutoMigrate(&models.User{}, ...)` unconditionally on startup — that's the entire migration story. There are no versioned migration files. Adding a field to a model is enough; GORM adds the column. Switching to Postgres later requires no code changes, just config.

**Auth**: every model embeds `models.Base` (UUID `id` + `createdAt`/`updatedAt`, JSON tags matching the frontend's camelCase TS types in `frontend/src/lib/types/index.ts`). `POST /api/auth/login` is the only unauthenticated `/api/*` route; everything else requires `Authorization: Bearer <jwt>`, enforced in `router.go`'s `authMiddleware` — it inspects `huma.Operation.Security` for the `bearerAuth` scheme rather than gating routes by path, so a new operation is protected by default unless you explicitly omit `Security: authSecurity()`. A default admin (`config.seedAdmin.email`/`password` in `config.yaml`) is created on first boot if the `users` table is empty.

**Adding a new operation**: define the `XInput`/`XOutput` structs (path/query params via struct tags, JSON body under a `Body` field) in the relevant `internal/api/*.go` file, then `huma.Register(api, huma.Operation{...}, handler)` inside that file's `registerXRoutes`. The OpenAPI spec and Scalar docs pick it up automatically — nothing else to update.

**Known gap**: `workflows`/`executions`/`schedules`/`workers` have full CRUD here but the frontend doesn't call any of it yet (see `frontend/CLAUDE.md`) — only `auth` and `projects` are wired end-to-end today.
