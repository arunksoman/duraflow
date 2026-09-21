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

The backend lives in `../backend` (Go, see its CLAUDE.md) — this app has no database of its own. `src/lib/server/http.ts` points `API_BASE_URL` (default `http://localhost:8000/api`, matching the backend's default `port: 8000` + `basePath: /api`) at it; `src/lib/server/{auth,projects,workflows,workers,executions}.ts` are thin fetch wrappers around it, one per resource, each throwing a typed `*ApiError` on failure (same pattern throughout — copy the nearest existing one for a new resource). Session state is a bearer token in a `session` cookie, resolved to `locals.user` in `src/hooks.server.ts`'s `handleAuth`. `src/routes/(app)/+layout.server.ts` gates the whole `(app)` route group, redirecting to `/login?redirectTo=...` when unauthenticated.

In dev only, `getSessionUser` special-cases the literal cookie value `dev-bypass` (`DEV_BYPASS_TOKEN` in `auth.ts`) to log in as a fake `dev-user` without hitting the real API — this branch is statically dead in production builds (`dev` from `$app/environment`).

`src/hooks.server.ts` also composes in `paraglideMiddleware` (i18n) via `sequence(handleAuth, handleParaglide)`.

Shared domain types (`User`, `Project`, `Workflow`, `Execution`, `Worker`, `WorkflowMeta`, etc.) live in `src/lib/types/index.ts` and are used on both client and server. The backend's GORM models and DTOs (`../backend/internal/models`, `../backend/internal/api`) mirror these field-for-field (camelCase JSON tags) — keep them in sync when either side changes.

Every domain type has a real page now: `/dashboard` and `/projects/[projectId]` (projects + workflow list/create/delete), the builder (load/save DSL — see below), `/workers`, `/executions` (`/workers` aggregates across every project client-side in its `+page.server.ts` `load` since the backend has no cross-project list endpoint for it — see that file for the `Promise.all` fan-out pattern; executions use the backend's filtered, paged `GET /executions` instead). There is deliberately **no schedules page**: a workflow's schedule is part of its DSL and is edited in the builder (see "Scheduling" below). `Sidebar.svelte`'s `navItems` no longer has any `enabled: false` entries. `/executions` is the cross-project run list (root runs only — child-workflow runs belong to their parent's timeline), filterable by workflow, run type (`trigger`: `manual`/`scheduled`/`backfill` — `backfill` isn't produced yet), status and start date; the filters live in the URL query string. Runs can be deleted there (per row or bulk) and from `/executions/[id]`, via `DeleteRunsDialog.svelte`; a delete is permanent and removes child runs, the event log and Temporal history too. `/executions/[id]` is a single run, rendered with the same `RunWorkspace` as the builder's run window.

### Run observability

After a run starts, what happened comes from the backend's stored CloudEvents stream, not from Temporal history (see `backend/CLAUDE.md` for why). The frontend side is four pieces:

| File                           | Responsibility                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zigflow-engine/runIndex.ts`   | `buildRunIndex(graph)` — walks the scope tree from `ROOT_SCOPE_ID`, mapping `(scopeId, taskName) -> nodeId`. Task names are only unique _within_ a scope, which is why this is not a flat map |
| `zigflow-engine/runScope.ts`   | Turns the backend's `scopePath` (`for_0`, `try`, `fork_<branch>`, `for_0_try`) into a canvas scope id, degrading to name-only matching rather than guessing                                   |
| `zigflow-engine/runState.ts`   | Pure reducer: events → per-node state + log. `finalizeRunState` turns everything still `pending` into `skipped`, which is what makes the path _not_ taken visible                             |
| `runtime/runSession.svelte.ts` | Owns the `EventSource`, reconnects from `lastSeq`, and keeps child runs current. All decisions live in `runState.ts` so they stay testable                                                    |

`runState.ts` keeps every execution of a node as its own `NodeAttempt` in `NodeRunDetail.history` (loop iterations, retries and back-jumps each get one, with their own input, output and before/after workflow state); `buildRunSteps` flattens those into the ordered path a run took, `workflowVariables` strips zigflow's runtime `task`/`workflow` bookkeeping out of a state snapshot, and `diffValues` reports what a task added/changed/removed. Only root-scope `workflow.started`/`workflow.completed` events set the run's input/output — every `for` iteration, `fork` branch and `try` block emits its own.

The UI is `components/execution/RunWorkspace.svelte` — a read-only canvas coloured by run state with the travelled edges highlighted, and a node inspector (`RunInspector`: input/output and a variables diff, with a per-attempt selector, built on `JsonPanel`/`JsonTree`). It's shared verbatim by the builder's run window (`RunModal.svelte`) and `/executions/[id]`, so a live run and a replayed one render identically. There is no raw event-log view and no separate steps list — the canvas colours carry the path. `WorkflowNode.svelte` reads `data.runState` — `running`/`success`/`error`/`skipped`/`unknown` — plus `data.runAttempts`, `data.childExecutionId` and `data.readOnly` (hides the hover delete button).

Status colours come from `components/builder/runStatus.ts` (`runTone` maps a `NodeRunState` to a tone) and the `--run-*` CSS variables in `src/routes/layout.css`: every node has the same neutral 2px border at rest (in the builder too — the icon carries the node type), then success green, running blue (edges into a running node are blue animated dashes), error red, and not-on-path (`skipped`) amber dashed. `partial` (pear) is reserved and not produced yet.

**The builder's Run button opens `RunModal`, and the run happens inside it.** Before the first run (or after "Clear run", which calls `RunSession.reset()` — the stored run is untouched) the window's canvas shows the current design, uncoloured. A workflow with no declared inputs starts immediately; otherwise Run opens a small inputs dialog over the window (a no-input workflow can still pass `$input` JSON via the `{}` button). Closing the window only hides it — a run in progress keeps going, and reopening shows the last run; "Run again" saves the current design and re-runs in the same window, clearing the previous highlighting first. The design canvas itself never shows run state. Builder runs are sent with `trigger: 'manual'`.

`RunSession` keeps every received event by seq. The server can deliver an event after one with a higher seq (the resolver attributes a task's start after its finish), and the reducer ignores anything at or below the seq it has reached, so a late event makes the session replay the whole log in order; when the run finishes it re-reads the full log (`afterSeq=0`) for the same reason.

Build the run index — and snapshot the `scopes` the run window draws — at the moment you compute the DSL you're about to run, and freeze both for that run's duration: they have to describe the DSL that was actually submitted, or incoming events get attributed to the wrong nodes.

### Workflow builder & the Zigflow DSL engine

The builder route is `/projects/[projectId]/workflows/[workflowId]/builder` (uses `+layout@.svelte` to reset the `(app)` chrome). `+page.server.ts` loads the workflow (and project, for the breadcrumb) and exposes a `?/save` form action that PATCHes the current DSL; the toolbar's Save button is a real `<form use:enhance>`, not a client-only flash. On mount, a non-reactive top-level script statement (see the comment above it — plain script code runs exactly once per component instance, no `$effect` needed) seeds the canvas from `data.workflow.dsl` via the existing `applyDslToCanvas` if present.

The canonical persisted form of a workflow is Zigflow YAML text (`Workflow.dsl`), **not** the canvas — the canvas is always derived from the DSL. `src/lib/zigflow-engine/` is a plain-TypeScript, UI-independent module (no Svelte imports) that owns everything DSL-shaped:

| File                                          | Responsibility                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema/zigflow.schema.json`                  | Vendored copy of the published Zigflow JSON Schema (draft 2020-12) — not fetched at runtime                                                                                |
| `ast.ts`                                      | Discriminated-union types mirroring the schema's 11 real task types + shared `TaskBase`                                                                                    |
| `validate.ts`                                 | `ajv`-based grammar validation (`validateZigflowDocument`)                                                                                                                 |
| `serialize.ts`                                | AST → plain object → YAML text (via the `yaml` package; explicit block-literal styling for multiline scripts/bodies)                                                       |
| `deserialize.ts`                              | YAML text → parse → validate → AST, with structured errors mapped back to source ranges                                                                                    |
| `graph.ts`                                    | Bidirectional AST ⟷ per-scope `{nodes, edges}` conversion                                                                                                                  |
| `layout.ts`                                   | Custom auto-layout (no dagre/elkjs): `layoutScope` (simple chain) + `layoutScopeRecursive` (arbitrary-depth inline lanes)                                                  |
| `inlineScopeView.ts`                          | Composes/decomposes the canvas's fully-inline rendering of nested scopes (see below)                                                                                       |
| `scopeKey.ts`                                 | Deterministic scope-id builders (`forScopeKey`, `tryScopeKey`, `catchScopeKey`, `forkBranchScopeKey`) shared by `graph.ts` and the Svelte layer                            |
| `slug.ts`                                     | Task-name slugging helpers                                                                                                                                                 |
| `schedule.ts`                                 | The workflow's recurring trigger as one UI object, and its lossless split across `schedule:` + `document.metadata` — see "Scheduling" below                                |
| `cron.ts`                                     | Pure 5-field cron ⟷ preset conversion (`parseCronPreset`/`buildCronPreset`), backing the visual cron editor                                                                |
| `header.ts`                                   | Tolerant, schema-free reads of a raw DSL string — `parseDocumentHeader` (taskQueue/workflowType) and `parseInputSchemaFromDsl`, for workflows never loaded into the canvas |
| `inputSchema.ts`                              | The value side of a declared `$input` schema: skeletons, validation, form-string coercion                                                                                  |
| `runIndex.ts` / `runScope.ts` / `runState.ts` | Run-to-canvas correlation — see "Run observability" above                                                                                                                  |

The Svelte layer (`+page.svelte`, `NodePanel.svelte`) only ever calls the public functions (`serializeZigflowDocument`, `deserializeZigflowDocument`, `astToGraph`, `graphToAst`) — it never hand-builds YAML strings or task objects. Every engine file has a co-located `*.test.ts` under the vitest `server` project.

**The canvas is fully inline — there is no drill-in navigation.** Every nested task body (`for.do`, each `fork` branch, `try.try`/`try.catch.do`, bare `do`) renders as tagged sibling nodes in its own lane on the same canvas, recursively to arbitrary depth (a fork branch containing a nested for-loop shows that loop's body inline too). The underlying data model (`scopes[...]` keyed by `scopeKey.ts`) is unchanged from an earlier drill-in design — only the rendering layer in `inlineScopeView.ts` differs. `start`/`end` nodes are always auto-present and connected; every dead-end node gets a synthetic (non-persisted, visual-only) edge to `end`.

**One document can declare several workflows, and the canvas shows each exactly like the primary
one: its own Start, its steps, its own End.** This follows zigflow's runtime rule, read from its
source (`DoTaskBuilder.Build`) and confirmed by running it: in _any_ task list, at any depth, a
`do:` task that comes after a non-`do:` task is **not run in place** — zigflow registers it as a
Temporal workflow of its own, named by its task key (a _named workflow_). A `do:` before every other
task in its list runs in place as a plain group (`do` node). At the top level of a document holding
nothing but `do:` tasks, every one is a named workflow. `graph.ts`'s `namedWorkflowEntries` is the
one place that rule lives. Check behaviour against the CLI (`zigflow validate` / `zigflow graph` /
`zigflow run`) rather than inferring it — `zigflow graph` does not draw nested declarations, the
runtime does register them.

There is **no dedicated node type** for a named workflow. It is a scope of its own,
`workflowScopeKey(startId)` = `workflow/<startId>` (deliberately _not_ prefixed by the scope that
declares it), holding a plain `start` node (id = `startId`, `data.label` = the workflow's name,
`data.variables` = its parameters, `data.declaredIn` = the scope key of the list its `do:` is written
in), its steps, and a plain `end` node (`workflowEndNodeId(startId)`), chained exactly like the root
scope. `isNamedWorkflowStart` tells it apart from the primary Start (id `start`); `flowScopeOf` maps
any scope key to the top-level flow it belongs to. Helpers live in `graph.ts`
(`namedWorkflowScopes`/`namedWorkflowStart`/`namedWorkflowNames`/`newNamedWorkflowScope`).

- **Save**: `scopeToTaskList` emits a list's named workflows _after_ its steps (order within a list
  changes nothing at runtime), each as `<name>: { do: [init?, ...steps] }`. Names are allocated once,
  document-wide (`namedWorkflowNames`), since zigflow registers them in one namespace; a sibling task
  with the same name is the one renamed. A workflow whose `declaredIn` scope is gone, or no longer
  holds a non-`do:` task (so its `do:` would run in place), is written at the top level instead.
- **Parameters**: a Start's `variables` (the primary Start's _and_ a named one's) are emitted as a
  leading `init: set:` in that workflow's list, and a leading `init` task that is only a `set:` is
  lifted back onto the Start on load (`splitInitTask`). `runIndex.ts` maps the `init` task's events
  to the Start node.
- **Canvas**: `composeScopeForDisplay` lays out the primary flow and then every named flow as its
  own column to the right (`layoutFlows`). No frame, no lane, no entry edge. Dead ends run to the End
  of _their own_ flow (`computeTerminalEdges`); `computeFlowBounds` gives each named flow a
  (non-drawn) hit area so a palette drop beside it lands in it.
- **Adding one**: the palette's **Start** (`start` is `showInPalette: true`; `End` is not — every
  workflow already has one) opens `WorkflowNameDialog` for the name (unique, it is the Temporal
  workflow type) and parameters, then creates the scope via `newNamedWorkflowScope`. Deleting a
  named Start deletes the whole flow (every scope whose `flowScopeOf` is it); its End is never
  deletable on its own.

**Every inline lane is drawn as a dotted frame** (`LaneBoxLayer.svelte`, rendered into xyflow's
_back_ `ViewportPortal` so it sits behind the nodes and follows pan/zoom for free).
`computeLiveLaneBoxes` derives the frames from where the nodes actually are, every render — titled
from `LaneSpec.title` with the name the DSL knows that group by: a fork branch's name, `<task>
try`/`catch`, `<task> body`, or a nested `do`'s own label. Without the frame a nested body is an
unlabeled column of cards and the canvas stops matching the document. A frame also encloses the
lanes nested inside it — descendant scope keys are prefixed by their ancestor's, so the union needs
no tree walk — which is why `resolveDropOwnerScope` picks the _deepest_ matching lane rather than
the first. Named workflows are not lanes and get no frame.

Frames are **capped** with a start marker above the lane's first node and an end marker below its
last (`LaneBox.caps`), because a nested body runs from its first task to its last and a frame
without them gives the eye nowhere to enter or leave. The caps are drawn by `LaneBoxLayer` rather
than added to `nodes` — no DSL task backs them, and a synthetic entry in the array xyflow two-way
binds would have to be filtered back out of every save, delete, drag and hit-test. `layout.ts`'s
`LANE_CAP_GAP` reserves the room they sit in (two gaps must stay under one `rowHeight` —
`positionChain` pays for both with a single extra reserved row), and the caps are excluded from the
nested-lane union, since they mark where _this_ lane's own chain begins and ends. Lane entry edges
carry an explicit `labelStyle` (xyflow's default HTML label is a white pill, invisible on dark).

**A `switch` is authored on the canvas.** `CaseEntry.routing` is per case:

- **`task`** — the case **starts a named workflow**. Zigflow runs every named `then:` of a switch
  as a Temporal _child workflow_ of that name (`executeRedirect` → `ExecuteChildWorkflow`), wherever
  the switch and the workflow are declared, waits for it, then carries on with the task after the
  switch. Drawn as a labeled edge into that workflow's Start (`computeSwitchCaseEdges` /
  `SwitchCaseEdge.svelte`), which is why a named Start has a target handle. Resolved through
  `targetNodeId` on save so renaming the workflow keeps the case (`resolveCaseTargets` resolves
  names on load, named workflows first). A `then:` naming a plain sibling task only loads from
  hand-written DSL (zigflow would fail to start it); it is still drawn, and flagged in the picker.
- **`continue` / `exit` / `end`** — the flow directives, drawn to the next task, or to the End of
  the workflow the switch is in.

There is deliberately **no "own branch" routing, and no convergence**: the steps a case runs are a
named workflow, drawn as its own flow. (An earlier model lifted handler tasks into per-case lanes
and wrote a converging `then:` into each; another drew named workflows as a special `workflow` node
inside a frame. Both are gone — don't reintroduce either.) `planSwitchCases` restructures nothing.
`example/switch.yaml` round-trips with the same shape it was written in.

Task names are preserved verbatim: `uniqueTaskName` in `slug.ts` only slugs a label that isn't
already identifier-shaped, so `processElectronicOrder` survives a canvas round-trip.

**Cases are edited on the canvas.** Dragging a connection out of a switch onto a named workflow's
Start adds a case that starts it; onto the End of the switch's own workflow, an `end` case. Either
opens `SwitchCaseDialog`; clicking a case edge edits it; deleting one drops the case. Any other drag
out of a switch is undone, and a plain edge into a named Start is refused. Case edges carry
`SWITCH_NODE_TAG`/`SWITCH_CASE_TAG` in `edge.data`, which is what the click/delete handlers key off.
`switchCases.ts` is the single reader of `node.data.cases` (and `caseTargetOptions` the single case
picker list), shared by `graph.ts`, `inlineScopeView.ts`, `runIndex.ts` and the dialogs.

**Run correlation of named workflows.** A named workflow's run is a child workflow whose id
(`<parentRunId>_N`) says nothing, so the backend resolver gives its events the scope segment
`workflow_<name>` (from the child's workflow type); `runScope.ts` resolves that token by name from
any scope (`RunIndex.workflowScopeByName`, longest match first). `runState.ts` records each named
workflow's own `workflow.started`/`completed` in `RunState.namedWorkflows`, and `RunWorkspace`
colours its Start/End from that (falling back to "one of its steps ran" for runs recorded before the
backend tagged them). A case edge is lit only when the workflow it starts ran; directive cases are
never lit, since they can't be told apart from a plain fall-through.

There is intentionally **no dedicated "if" branching node** — every task's shared `if:` guard (`DataFlow.if`, edited via the "Run only if" `ConditionBuilder` section in `NodePanel.svelte`) is the sole conditional-execution mechanism; real two-way branching is done with a `switch` task. (This was tried twice — a compiled-to-switch "if" node, and a canvas guard-diamond visualization — and explicitly reverted both times; don't reintroduce either without asking.)

Node type reference (per-node `data` shape, DSL mapping, quirks) is documented in `docs/internal/nodes.md` — read it before touching `builderConfig.ts`, `NodePanel.svelte`, or `graph.ts`. Note its drill-in/"Edit body" references describe an earlier version of the rendering layer; the per-node data shapes and DSL mappings are still accurate.

### Scheduling

A workflow's recurring trigger is edited in the builder, from the **Schedule** button next to Run (`ScheduleModal.svelte`, with `CronBuilder.svelte` inside it), and travels with the rest of the design as `WorkflowMeta.schedule` — so it round-trips through the DSL editor like everything else: paste a DSL with a `schedule:` block and the panel shows it; change the panel and the YAML updates.

Zigflow splits the concept across two places, and `zigflow-engine/schedule.ts` is the only thing that knows that: the spec itself is the top-level `schedule:` (`cron`, `every`, or both — Temporal fires on either), while `document.metadata` carries `scheduleWorkflowName` (required — zigflow errors without it), `scheduleId` (defaults to `zigflow_<workflowType>`) and `scheduleInput` (a Temporal _argument list_, so the panel's one input object is written as a single-element array).

**Turning a schedule off means removing `schedule:` entirely** — an `enabled: false` flag in the DSL would do nothing, because zigflow only reads presence. So that the toggle doesn't discard the user's cron, the whole configuration is parked under `document.metadata.duraflow.disabledSchedule` instead; exactly one of the two representations exists at a time, so there's never a second source of truth. A workflow that has never been scheduled writes no schedule keys at all — don't give `defaultWorkflowSchedule()` a spec flag that's on by default, or every DSL in the system grows a `duraflow` block.

`CronBuilder.svelte` derives its controls from the expression rather than mirroring it into local state, so hand-typing a cron redraws the controls and vice versa; anything `parseCronPreset` doesn't recognise (a constrained month, a day-of-month/day-of-week OR, ranges) degrades to five raw fields rather than being guessed at. `cronstrue` renders the plain-English description and `cron-parser` the next three fire times — **both in UTC**, which is what Temporal evaluates the cron in.

Key reusable components: `ExpressionInput.svelte` (chip-based `${ expr }` builder) and `ConditionBuilder.svelte` (visual jq condition builder, built on `ExpressionInput`) are used throughout the builder — their autocomplete/suggestion logic and styling should not be changed without explicit direction. `CodeMirrorEditor.svelte` is a thin CodeMirror 6 wrapper (no third-party Svelte CM library), theme-reactive via `src/lib/utils/theme.svelte.ts`, used for the DSL YAML editor, `run` node script/shell fields, and an alternate raw-JSON toggle for `call`'s body.

### i18n

Paraglide (`@inlang/paraglide-js`) compiles messages from `messages/*.json` into `src/lib/paraglide/` (generated, via the `paraglideVitePlugin` in `vite.config.ts` — don't hand-edit generated output). `src/hooks.server.ts` wires `paraglideMiddleware` for locale detection/HTML attribute injection.
