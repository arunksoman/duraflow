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

The backend lives in `../backend` (Go, see its CLAUDE.md) — this app has no database of its own. `src/lib/server/http.ts` points `API_BASE_URL` (default `http://localhost:8000/api`, matching the backend's default `port: 8000` + `basePath: /api`) at it; `src/lib/server/{auth,projects,workflows,schedules,workers,executions}.ts` are thin fetch wrappers around it, one per resource, each throwing a typed `*ApiError` on failure (same pattern throughout — copy the nearest existing one for a new resource). Session state is a bearer token in a `session` cookie, resolved to `locals.user` in `src/hooks.server.ts`'s `handleAuth`. `src/routes/(app)/+layout.server.ts` gates the whole `(app)` route group, redirecting to `/login?redirectTo=...` when unauthenticated.

In dev only, `getSessionUser` special-cases the literal cookie value `dev-bypass` (`DEV_BYPASS_TOKEN` in `auth.ts`) to log in as a fake `dev-user` without hitting the real API — this branch is statically dead in production builds (`dev` from `$app/environment`).

`src/hooks.server.ts` also composes in `paraglideMiddleware` (i18n) via `sequence(handleAuth, handleParaglide)`.

Shared domain types (`User`, `Project`, `Workflow`, `Execution`, `Schedule`, `Worker`, `WorkflowMeta`, etc.) live in `src/lib/types/index.ts` and are used on both client and server. The backend's GORM models and DTOs (`../backend/internal/models`, `../backend/internal/api`) mirror these field-for-field (camelCase JSON tags) — keep them in sync when either side changes.

Every domain type has a real page now: `/dashboard` and `/projects/[projectId]` (projects + workflow list/create/delete), the builder (load/save DSL — see below), `/workers`, `/schedules`, `/executions` (`/workers` and `/schedules` aggregate across every project client-side in their `+page.server.ts` `load` since the backend has no cross-project list endpoints for them — see those files for the `Promise.all` fan-out pattern; executions use the backend's filtered, paged `GET /executions` instead). `Sidebar.svelte`'s `navItems` no longer has any `enabled: false` entries. `/executions` is the cross-project run list (root runs only — child-workflow runs belong to their parent's timeline), filterable by workflow, run type (`trigger`: `manual`/`scheduled`/`backfill` — only `manual` is produced today), status and start date; the filters live in the URL query string. Runs can be deleted there (per row or bulk) and from `/executions/[id]`, via `DeleteRunsDialog.svelte`; a delete is permanent and removes child runs, the event log and Temporal history too. `/executions/[id]` is a single run, rendered with the same `RunWorkspace` as the builder's run window.

### Run observability

After a run starts, what happened comes from the backend's stored CloudEvents stream, not from Temporal history (see `backend/CLAUDE.md` for why). The frontend side is four pieces:

| File | Responsibility |
| --- | --- |
| `zigflow-engine/runIndex.ts` | `buildRunIndex(graph)` — walks the scope tree from `ROOT_SCOPE_ID`, mapping `(scopeId, taskName) -> nodeId`. Task names are only unique *within* a scope, which is why this is not a flat map |
| `zigflow-engine/runScope.ts` | Turns the backend's `scopePath` (`for_0`, `try`, `fork_<branch>`, `for_0_try`) into a canvas scope id, degrading to name-only matching rather than guessing |
| `zigflow-engine/runState.ts` | Pure reducer: events → per-node state + log. `finalizeRunState` turns everything still `pending` into `skipped`, which is what makes the path *not* taken visible |
| `runtime/runSession.svelte.ts` | Owns the `EventSource`, reconnects from `lastSeq`, and keeps child runs current. All decisions live in `runState.ts` so they stay testable |

`runState.ts` keeps every execution of a node as its own `NodeAttempt` in `NodeRunDetail.history` (loop iterations, retries and back-jumps each get one, with their own input, output and before/after workflow state); `buildRunSteps` flattens those into the ordered path a run took, `workflowVariables` strips zigflow's runtime `task`/`workflow` bookkeeping out of a state snapshot, and `diffValues` reports what a task added/changed/removed. Only root-scope `workflow.started`/`workflow.completed` events set the run's input/output — every `for` iteration, `fork` branch and `try` block emits its own.

The UI is `components/execution/RunWorkspace.svelte` — a read-only canvas coloured by run state with the travelled edges highlighted, and a node inspector (`RunInspector`: input/output and a variables diff, with a per-attempt selector, built on `JsonPanel`/`JsonTree`). It's shared verbatim by the builder's run window (`RunModal.svelte`) and `/executions/[id]`, so a live run and a replayed one render identically. There is no raw event-log view and no separate steps list — the canvas colours carry the path. `WorkflowNode.svelte` reads `data.runState` — `running`/`success`/`error`/`skipped`/`unknown` — plus `data.runAttempts`, `data.childExecutionId` and `data.readOnly` (hides the hover delete button).

Status colours come from `components/builder/runStatus.ts` (`runTone` maps a `NodeRunState` to a tone) and the `--run-*` CSS variables in `src/routes/layout.css`: every node has the same neutral 2px border at rest (in the builder too — the icon carries the node type), then success green, running blue (edges into a running node are blue animated dashes), error red, and not-on-path (`skipped`) amber dashed. `partial` (pear) is reserved and not produced yet.

**The builder's Run button opens `RunModal`, and the run happens inside it.** Before the first run (or after "Clear run", which calls `RunSession.reset()` — the stored run is untouched) the window's canvas shows the current design, uncoloured. A workflow with no declared inputs starts immediately; otherwise Run opens a small inputs dialog over the window (a no-input workflow can still pass `$input` JSON via the `{}` button). Closing the window only hides it — a run in progress keeps going, and reopening shows the last run; "Run again" saves the current design and re-runs in the same window, clearing the previous highlighting first. The design canvas itself never shows run state. Builder runs are sent with `trigger: 'manual'`.

`RunSession` keeps every received event by seq. The server can deliver an event after one with a higher seq (the resolver attributes a task's start after its finish), and the reducer ignores anything at or below the seq it has reached, so a late event makes the session replay the whole log in order; when the run finishes it re-reads the full log (`afterSeq=0`) for the same reason.

Build the run index — and snapshot the `scopes` the run window draws — at the moment you compute the DSL you're about to run, and freeze both for that run's duration: they have to describe the DSL that was actually submitted, or incoming events get attributed to the wrong nodes.

### Workflow builder & the Zigflow DSL engine

The builder route is `/projects/[projectId]/workflows/[workflowId]/builder` (uses `+layout@.svelte` to reset the `(app)` chrome). `+page.server.ts` loads the workflow (and project, for the breadcrumb) and exposes a `?/save` form action that PATCHes the current DSL; the toolbar's Save button is a real `<form use:enhance>`, not a client-only flash. On mount, a non-reactive top-level script statement (see the comment above it — plain script code runs exactly once per component instance, no `$effect` needed) seeds the canvas from `data.workflow.dsl` via the existing `applyDslToCanvas` if present.

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
| `slug.ts` | `toTaskName` (task/branch/case names — a label that is already a valid name is kept verbatim, otherwise camelCased so `$data.<task>` needs no quoting) and `toSlug` (RFC 1123, only for `workflowType`/`taskQueue`) |
| `expression.ts` | Lossless `${ jq }` ⟷ token model behind `ExpressionInput`: variable refs (`$input`/`$data`/`$context`/`$output`/`$env`/`.` + nested path + pipe transforms), text literals, and verbatim `raw` jq for anything else |
| `condition.ts` | `${ a and b or c }` ⟷ clause model behind `ConditionBuilder` (comparisons, `contains`/`startswith`/`endswith`/`test`, truthy/falsy); unrecognised clauses are kept as truthy over their verbatim jq |
| `dataFlow.ts` | Recognises the guided shapes of `output.as` (object of field values) and `export.as` (`$context + { ... }`) for `DataFlowEditor` |
| `header.ts` | Tolerant, schema-free reads of a raw DSL string — `parseDocumentHeader` (taskQueue/workflowType) and `parseInputSchemaFromDsl`, for workflows never loaded into the canvas |
| `inputSchema.ts` | The value side of a declared `$input` schema: skeletons, validation, form-string coercion |
| `runIndex.ts` / `runScope.ts` / `runState.ts` | Run-to-canvas correlation — see "Run observability" above |

The Svelte layer (`+page.svelte`, `NodePanel.svelte`) only ever calls the public functions (`serializeZigflowDocument`, `deserializeZigflowDocument`, `astToGraph`, `graphToAst`) — it never hand-builds YAML strings or task objects. Every engine file has a co-located `*.test.ts` under the vitest `server` project.

**The canvas is fully inline — there is no drill-in navigation.** Every nested task body (`for.do`, each `fork` branch, `try.try`/`try.catch.do`, bare `do`) renders as tagged sibling nodes in its own lane on the same canvas, recursively to arbitrary depth (a fork branch containing a nested for-loop shows that loop's body inline too). The underlying data model (`scopes[...]` keyed by `scopeKey.ts`) is unchanged from an earlier drill-in design — only the rendering layer in `inlineScopeView.ts` differs. `start`/`end` nodes are always auto-present and connected; every dead-end node gets a synthetic (non-persisted, visual-only) edge to `end`.

There is intentionally **no dedicated "if" branching node** — every task's shared `if:` guard (`DataFlow.if`, edited via the "Run only if" `ConditionBuilder` section in `NodePanel.svelte`) is the sole conditional-execution mechanism; real two-way branching is done with a `switch` task. (This was tried twice — a compiled-to-switch "if" node, and a canvas guard-diamond visualization — and explicitly reverted both times; don't reintroduce either without asking.)

Node type reference (per-node `data` shape, DSL mapping, quirks) is documented in `docs/internal/nodes.md` — read it before touching `builderConfig.ts`, `NodePanel.svelte`, or `graph.ts`. Note its drill-in/"Edit body" references describe an earlier version of the rendering layer; the per-node data shapes and DSL mappings are still accurate.

Key reusable components: `ExpressionInput.svelte` (chip-based `${ expr }` builder — each variable chip is source badge `I/D/C/O/E` | path | jq transformer, click a chip to edit it in place; `mode="jq"` for bare-jq operands), `ConditionBuilder.svelte` (visual condition builder, built on `ExpressionInput`) and `DataFlowEditor.svelte` (guided `output.as`/`export.as`) are used throughout the builder — their autocomplete/suggestion logic and styling should not be changed without explicit direction. All three are controlled fields that remember the value they last emitted and re-parse only when `value` arrives as something else, so a removed row or a different node never leaves stale chips behind; `NodePanel` is additionally wrapped in `{#key configNode.id}` in the builder page. Suggestions come from `components/builder/availableVars.ts` (`computeAvailableVars`): `$input` schema fields, `$env` vars, Start init values, upstream `set` keys, upstream task results (`$data.<taskName>`), upstream `$context` keys, plus the item/index of enclosing `for` loops and the error of an enclosing `catch`. Browser tests for these live in `ExpressionInput.svelte.test.ts`. `CodeMirrorEditor.svelte` is a thin CodeMirror 6 wrapper (no third-party Svelte CM library), theme-reactive via `src/lib/utils/theme.svelte.ts`, used for the DSL YAML editor, `run` node script/shell fields, and an alternate raw-JSON toggle for `call`'s body.

### i18n

Paraglide (`@inlang/paraglide-js`) compiles messages from `messages/*.json` into `src/lib/paraglide/` (generated, via the `paraglideVitePlugin` in `vite.config.ts` — don't hand-edit generated output). `src/hooks.server.ts` wires `paraglideMiddleware` for locale detection/HTML attribute injection.
