# CLAUDE.md (frontend)

This file provides guidance to Claude Code (claude.ai/code) when working with code in `frontend/`. See the root [CLAUDE.md](../CLAUDE.md) for the monorepo overview and [../backend/CLAUDE.md](../backend/CLAUDE.md) for the Go API.

## Project Configuration

- **Language**: TypeScript
- **Package Manager**: pnpm
- **Add-ons**: prettier, eslint, vitest, tailwindcss, paraglide, mdsvex, mcp

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.

---

## Commands

All commands below run from `frontend/` (e.g. `pnpm --dir frontend dev` from the repo root, or `cd frontend` first).

```sh
pnpm dev                 # dev server (vite dev)
pnpm build               # production build
pnpm preview             # preview production build
pnpm check               # svelte-kit sync + svelte-check (type checking)
pnpm check:watch         # same, watch mode
pnpm lint                # prettier --check . && eslint .
pnpm format              # prettier --write .
pnpm test                # vitest run (single run, both projects)
pnpm test:unit           # vitest (watch mode)
```

Run a single test file: `pnpm vitest run src/lib/zigflow-engine/graph.test.ts`
Run a single test by name: `pnpm vitest run -t "test name substring"`

Vitest is split into two projects (`vite.config.ts`):

- **`server`**: plain Node env, matches `src/**/*.{test,spec}.{js,ts}` excluding `*.svelte.test.ts`. Used by `src/lib/zigflow-engine/*.test.ts` — pure TS, no Svelte/browser dependency.
- **`client`**: real Chromium via Playwright (`@vitest/browser-playwright`), matches `src/**/*.svelte.{test,spec}.{js,ts}`, excludes `src/lib/server/**`.

`expect: { requireAssertions: true }` is set globally — a test with no assertion fails.

There is no separate e2e test command; manual Playwright smoke-testing has been done ad hoc during builder feature work (see git history) but isn't wired into `package.json`.

---

## Architecture

### Auth & data flow

The backend lives in `../backend` (Go, see its CLAUDE.md) — this app has no database of its own. `src/lib/server/http.ts` points `API_BASE_URL` (default `http://localhost:8000/api`, matching the backend's default `port: 8000` + `basePath: /api`) at it; `src/lib/server/auth.ts` and `src/lib/server/projects.ts` are thin fetch wrappers around it, throwing typed `AuthError`/`ProjectsApiError` on failure. Session state is a bearer token in a `session` cookie, resolved to `locals.user` in `src/hooks.server.ts`'s `handleAuth`. `src/routes/(app)/+layout.server.ts` gates the whole `(app)` route group, redirecting to `/login?redirectTo=...` when unauthenticated.

In dev only, `getSessionUser` special-cases the literal cookie value `dev-bypass` (`DEV_BYPASS_TOKEN` in `auth.ts`) to log in as a fake `dev-user` without hitting the real API — this branch is statically dead in production builds (`dev` from `$app/environment`).

`src/hooks.server.ts` also composes in `paraglideMiddleware` (i18n) via `sequence(handleAuth, handleParaglide)`.

Shared domain types (`User`, `Project`, `Workflow`, `Execution`, `Schedule`, `Worker`, `WorkflowMeta`, etc.) live in `src/lib/types/index.ts` and are used on both client and server. The backend's GORM models and DTOs (`../backend/internal/models`, `../backend/internal/api`) mirror these field-for-field (camelCase JSON tags) — keep them in sync when either side changes.

Note: the backend now exposes full CRUD for `workflows`/`executions`/`schedules`/`workers` (see `../backend/CLAUDE.md`), but the frontend doesn't call any of it yet beyond `auth`/`projects` — no `src/lib/server/workflows.ts` etc. exists, and the builder still doesn't persist the DSL anywhere. That wiring is a separate, not-yet-done piece of work.

### Workflow builder & the Zigflow DSL engine

The builder route is `/projects/[projectId]/workflows/[workflowId]/builder` (uses `+layout@.svelte` to reset the `(app)` chrome; no `+page.server.ts` — it's pure frontend, fetching/saving the workflow's DSL client-side).

The canonical persisted form of a workflow is Zigflow YAML text (`Workflow.dsl`), **not** the canvas — the canvas is always derived from the DSL. `src/lib/zigflow-engine/` is a plain-TypeScript, UI-independent module (no Svelte imports) that owns everything DSL-shaped:

| File | Responsibility |
| --- | --- |
| `schema/zigflow.schema.json` | Vendored copy of the published Zigflow JSON Schema (draft 2020-12) — not fetched at runtime |
| `ast.ts` | Discriminated-union types mirroring the schema's 11 real task types + shared `TaskBase` |
| `validate.ts` | `ajv`-based grammar validation (`validateZigflowDocument`) |
| `serialize.ts` | AST → plain object → YAML text (via the `yaml` package; explicit block-literal styling for multiline scripts/bodies) |
| `deserialize.ts` | YAML text → parse → validate → AST, with structured errors mapped back to source ranges |
| `graph.ts` | Bidirectional AST ⟷ per-scope `{nodes, edges}` conversion |
| `layout.ts` | Custom auto-layout (no dagre/elkjs): `layoutScope` (simple chain) + `layoutScopeRecursive` (arbitrary-depth inline lanes) |
| `inlineScopeView.ts` | Composes/decomposes the canvas's fully-inline rendering of nested scopes (see below) |
| `scopeKey.ts` | Deterministic scope-id builders (`forScopeKey`, `tryScopeKey`, `catchScopeKey`, `forkBranchScopeKey`) shared by `graph.ts` and the Svelte layer |
| `slug.ts` | Task-name slugging helpers |

The Svelte layer (`+page.svelte`, `NodePanel.svelte`) only ever calls the public functions (`serializeZigflowDocument`, `deserializeZigflowDocument`, `astToGraph`, `graphToAst`) — it never hand-builds YAML strings or task objects. Every engine file has a co-located `*.test.ts` under the vitest `server` project.

**The canvas is fully inline — there is no drill-in navigation.** Every nested task body (`for.do`, each `fork` branch, `try.try`/`try.catch.do`, bare `do`) renders as tagged sibling nodes in its own lane on the same canvas, recursively to arbitrary depth (a fork branch containing a nested for-loop shows that loop's body inline too). The underlying data model (`scopes[...]` keyed by `scopeKey.ts`) is unchanged from an earlier drill-in design — only the rendering layer in `inlineScopeView.ts` differs. `start`/`end` nodes are always auto-present and connected; every dead-end node gets a synthetic (non-persisted, visual-only) edge to `end`.

There is intentionally **no dedicated "if" branching node** — every task's shared `if:` guard (`DataFlow.if`, edited via the "Run only if" `ConditionBuilder` section in `NodePanel.svelte`) is the sole conditional-execution mechanism; real two-way branching is done with a `switch` task. (This was tried twice — a compiled-to-switch "if" node, and a canvas guard-diamond visualization — and explicitly reverted both times; don't reintroduce either without asking.)

Node type reference (per-node `data` shape, DSL mapping, quirks) is documented in `docs/internal/nodes.md` — read it before touching `builderConfig.ts`, `NodePanel.svelte`, or `graph.ts`. Note its drill-in/"Edit body" references describe an earlier version of the rendering layer; the per-node data shapes and DSL mappings are still accurate.

Key reusable components: `ExpressionInput.svelte` (chip-based `${ expr }` builder) and `ConditionBuilder.svelte` (visual jq condition builder, built on `ExpressionInput`) are used throughout the builder — their autocomplete/suggestion logic and styling should not be changed without explicit direction. `CodeMirrorEditor.svelte` is a thin CodeMirror 6 wrapper (no third-party Svelte CM library), theme-reactive via `src/lib/utils/theme.svelte.ts`, used for the DSL YAML editor, `run` node script/shell fields, and an alternate raw-JSON toggle for `call`'s body.

### i18n

Paraglide (`@inlang/paraglide-js`) compiles messages from `messages/*.json` into `src/lib/paraglide/` (generated, via the `paraglideVitePlugin` in `vite.config.ts` — don't hand-edit generated output). `src/hooks.server.ts` wires `paraglideMiddleware` for locale detection/HTML attribute injection.
