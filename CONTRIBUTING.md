# Contributing to Duraflow

Thanks for your interest in Duraflow! Bug reports, feature ideas, docs fixes and code are all welcome, and you don't need to be a Temporal or Svelte expert to help.

## Ways to contribute

- **Report a bug.** Open an issue with what you did, what you expected and what happened. Include the workflow DSL (from the builder's DSL view) whenever the bug involves a specific workflow, plus browser console or backend logs if you have them.
- **Suggest a feature.** Open an issue describing the problem you're trying to solve, not just the solution. It helps us find the design that fits.
- **Improve the docs.** Typos, unclear explanations and missing examples are all fair game.
- **Send a pull request.** For anything larger than a small fix, please open an issue first so we can agree on the approach before you invest the time.

## Repository layout

```
frontend/   SvelteKit app: builder canvas, Zigflow DSL engine, run console
backend/    Go API: projects, workflows, runs, worker management, run telemetry
docker/     Supporting images (currently the Temporal dev server)
example/    Example workflow definitions
```

Before changing either side, read its `CLAUDE.md` ([frontend](frontend/CLAUDE.md), [backend](backend/CLAUDE.md)). Despite the name, they are the most detailed architecture notes in the repo and apply to human contributors just as much.

## Development setup

### With Docker

```sh
docker compose up --build
```

This starts three services:

| Service | URL |
| --- | --- |
| Frontend | http://localhost:5173 |
| Backend API (docs at `/docs`) | http://localhost:8000 |
| Temporal (gRPC / web UI) | `localhost:7233` / http://localhost:8233 |

Log in with the seeded admin from `docker-compose.yml` (`DURAFLOW_SEEDADMIN_EMAIL` / `DURAFLOW_SEEDADMIN_PASSWORD`). The SQLite database and per-workflow DSL files persist in `backend/data/`. To reset everything, stop the stack and delete `backend/data/duraflow.db`.

If you open the frontend from any address other than `http://localhost:5173`, update `ORIGIN` in `docker-compose.yml` to match, or form submissions will fail with a CSRF error.

### Without Docker

You need Go (see `backend/go.mod` for the version), Node 20+ with pnpm, the [Temporal CLI](https://github.com/temporalio/cli/releases) and the [Zigflow CLI](https://github.com/zigflow/zigflow) (`go install github.com/zigflow/zigflow@latest`) on your `PATH`. Then, in three terminals:

```sh
temporal server start-dev                 # localhost:7233, web UI at :8233
cd backend && go run ./cmd/server         # localhost:8000, API docs at /docs
cd frontend && pnpm install && pnpm dev   # localhost:5173
```

The frontend reaches the backend at `http://localhost:8000/api` by default (override with `API_BASE_URL`, see `frontend/.env.example`), and the backend reaches Temporal at `localhost:7233`.

### Configuration

The backend reads built-in defaults, then an optional `backend/config/config.yaml`, then `DURAFLOW_*` environment variables, in increasing order of precedence. A YAML key maps to an env var by uppercasing it and replacing dots with underscores: `temporal.address` becomes `DURAFLOW_TEMPORAL_ADDRESS`.

The database is SQLite by default, and the schema migrates automatically on startup. To use Postgres, set `DURAFLOW_DATABASE_DRIVER=postgres` and `DURAFLOW_DATABASE_DSN`.

## Checks before you open a pull request

**Frontend** (from `frontend/`):

```sh
pnpm check   # type checking
pnpm lint    # prettier + eslint
pnpm test    # unit tests (Node) and component tests (headless Chromium)
```

Run `pnpm format` to fix formatting. Component tests need Playwright's Chromium: run `pnpm exec playwright install chromium` once.

**Backend** (from `backend/`):

```sh
go build ./...
go vet ./...
gofmt -l .   # should print nothing
```

## Guidelines

- **Keep the two sides in sync.** The frontend's types in `frontend/src/lib/types/index.ts` mirror the backend's models and DTOs field for field. If you change one, change the other.
- **The DSL is the source of truth.** Workflows are stored as Zigflow YAML, and the canvas is derived from it. Put DSL logic in `frontend/src/lib/zigflow-engine/` (plain TypeScript, no Svelte) with tests next to it, and never hand-build YAML in components.
- **Test what you fix.** Add a test that fails without your change whenever practical, especially in the DSL engine and run-state code.
- **Match the surrounding code.** Follow the existing naming, structure and comment style of the file you're editing, rather than introducing a new pattern.
- **Keep pull requests focused.** One logical change per PR is much easier to review than several bundled together.

## Commits and pull requests

- Branch from `main` and give the branch a descriptive name, like `fix/chip-reorder` or `feat/schedule-runner`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for messages: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with an optional scope such as `fix(builder): ...`.
- In the PR description, explain what changed and why, how you tested it, and include screenshots or a short recording for UI changes.
- Make sure the checks above pass before requesting review.

## License

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).
