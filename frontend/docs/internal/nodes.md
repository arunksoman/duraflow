# Node Reference — Duraflow Builder

All nodes live in `src/lib/components/builder/`. Node types are defined in `builderConfig.ts`. The panel UI is in `NodePanel.svelte`. The bidirectional DSL engine (AST, YAML serialize/deserialize, schema validation, node-graph conversion) is an independent module in `src/lib/zigflow-engine/` — see [Engine Module](#engine-module) below.

---

## Runtime Variables

These are available in every `ExpressionInput` / `ConditionBuilder` field:

| Ref           | Source                                      | Notes                                                                              |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `$input`      | Workflow trigger payload                    | Fields from `workflowMeta.inputSchema` (UI-only hint — not part of the DSL itself) |
| `$env`        | Environment variables                       | From `workflowMeta.envVars` (UI-only hint — not part of the DSL itself)            |
| `.`           | Current task input (shorthand for `$input`) | Always available                                                                   |
| `$output`     | Previous task's full output                 | Available after at least one task                                                  |
| `$data.<key>` | Mutable store                               | Written by `start.variables`, `set.variables`                                      |
| `$context`    | Accumulated exports                         | Written by `exportAs` on any upstream node                                         |

`$input`/`$env` field lists in the Variables modal are a canvas-only convenience for autocomplete hints — Zigflow's real `input` task/workflow property only supports a JSON Schema (`input.schema`), and `$env` vars aren't declared anywhere in the DSL (they're just referenced ad hoc via `${ $env.NAME }`). Neither round-trips through DSL text; only the task graph and document header (`workflowType`/`taskQueue`/`version`) do.

---

## Shared Fields (on every node except `start` / `end`)

```ts
interface DataFlow {
	if: string; // jq — TaskBase.if: skip this task unless truthy
	outputAs: string; // jq — reshape $output before passing downstream
	exportAs: string; // jq — merge result into $context
}
```

- **`if`** is rendered as a "Run only if" section in every node's config panel (reusing `ConditionBuilder`). It maps directly to Zigflow's real `if:` task property — there is no standalone "If" node; any task can be conditional.
- There is intentionally **no `input.from` field** — Zigflow's `input` task property only supports a `schema` (for input validation), not a data-reshaping expression. An earlier version of this app had a fabricated `input.from` field; it never corresponded to anything in the real DSL and has been removed.

---

## Nested Scopes & Drill-In Navigation

Real Zigflow tasks (`for`, `fork`, `try`) contain their own nested task lists (`for.do`, `fork.branches`, `try.try` / `try.catch.do`). The canvas represents each of these as its **own separate `{nodes, edges}` graph**, entered via drill-in navigation rather than nested/grouped canvas nodes:

- Click **"Edit loop body"** on a `For` node, **"Edit body"** on a `Fork` branch row, or **"Edit try body"/"Edit catch body"** on a `Try` node to open that nested scope as its own canvas view.
- A breadcrumb bar (shown once you're drilled in) lets you navigate back up.
- Each scope is keyed by a deterministic id built from `src/lib/zigflow-engine/scopeKey.ts` (`forScopeKey`, `tryScopeKey`, `catchScopeKey`, `forkBranchScopeKey`) — e.g. `root/<forNodeId>/do`.
- A root-level `do:` task is a whole separate Temporal workflow, not a group — it loads as a `workflow` node whose body is the scope `workflowScopeKey(nodeId)`. A `switch` owns no nested scope at all: every case is a jump. See the `switch` and `workflow` sections below.
- Every one of these lanes is drawn as a titled dotted frame (`LaneBoxLayer.svelte` + `computeLiveLaneBoxes`), named after the task the DSL saves that group as, with a start cap above its first node and an end cap below its last (`LaneBox.caps`; the room for them comes from `layout.ts`'s `LANE_CAP_GAP`). A frame encloses any lanes nested inside it, so a drop resolves to the **deepest** frame under the cursor — the caps, though, stay on the lane's own chain.
- A `switch` case's `then` can only name a task within the **same scope** (per the DSL spec), plus any named workflow, which is declared at the document's top level — the case editor's target picker offers exactly those.
- Editing the DSL text directly and letting it sync back to the canvas rebuilds every scope from scratch and returns you to the root view, since node identity can't be preserved across a full text-driven rebuild. This is an intentional simplification, not a bug.

---

## Nodes

### `start` — terminal

```ts
node.data = {
  label:     string
  variables: VarEntry[]   // { key: string, value: string }
}
```

- `variables` initialises `$data` keys before the first task runs — emitted as a synthetic leading `init: { set: {...} } }` task in the DSL (there is no real "start" task).
- No `DataFlow` fields. `showInPalette: false` — auto-created, one per workflow, only at the root scope.

---

### `end` — terminal

```ts
node.data = { label: string };
```

No config. Not a real DSL task either — reaching it (or a `switch`/`then: end`) simply terminates the workflow.

---

### `call` — action (REST)

```ts
node.data = {
  label:    string
  method:   'get' | 'post' | 'put' | 'patch' | 'delete'
  endpoint: string              // ExpressionInput
  headers:  VarEntry[]
  query:    VarEntry[]
  body:     string              // ExpressionInput (multiline) or CodeMirror JSON (toggle)
  output:   'content' | 'raw' | 'response'
  redirect: boolean
  ...DataFlow
}
```

Maps to `call: http` (the only `call` variant this app authors — the schema also supports `activity`/`grpc`, left for a future pass). The Body field has a toggle between the chip-based `ExpressionInput` and a raw CodeMirror JSON editor.

---

### `set` — action

```ts
node.data = {
  label:     string
  variables: VarEntry[]   // written into $data
  ...DataFlow
}
```

Writes key-value pairs into `$data`. Special jq builtins `${ uuid }` / `${ timestamp }` / `${ timestamp_iso8601 }` are only safe here (Temporal determinism).

---

### `switch` — control

```ts
node.data = {
  label: string
  cases: CaseEntry[]
  ...DataFlow
}

interface CaseEntry {
  id:            string        // stable key for this case and its edge
  name:          string        // case identifier (used as the DSL `switch:` entry key)
  condition:     string        // ConditionBuilder — blank = otherwise/default
  routing:       CaseRouting   // 'task' | 'continue' | 'exit' | 'end'
  taskName?:     string        // task: the name the document's `then:` had, as a fallback
  targetNodeId?: string        // task: the node jumped at — a sibling, or a named workflow
}
```

This is the **real** conditional-branching construct in Zigflow (not a dedicated "If" node). Cases
are evaluated top-to-bottom, first truthy match wins, and their array order is the DSL order — the
node panel can reorder them.

Every case is a jump, and one switch can mix the kinds:

- **`task`** — the case's `then:` names something: a task at the switch's own nesting depth, or a
  named workflow (top-level, so reachable from anywhere). Drawn as a labeled bowed edge
  (`computeSwitchCaseEdges` + `SwitchCaseEdge.svelte`). Re-resolved through `targetNodeId` on save so
  renaming the target keeps the jump, falling back to `taskName`.
- **`continue` / `exit` / `end`** — the flow directives, taken as written and drawn as a labeled
  edge to the next task / the `End` node.

There is no "own branch" routing and nothing converges. A case cannot run steps of its own and then
rejoin: `then:` names a task or a workflow, and a named workflow runs to its _own_ End (`zigflow
graph` ignores a `then:` on a root-level `do:` task outright). `planSwitchCases` in `graph.ts`
therefore restructures nothing — it reads each `then:` and keeps it.

Authoring is on the canvas: drag from the switch onto a reachable task, a named workflow's Start, or
the `End` node to add a case (the condition editor opens), click a case edge to edit its
condition/routing, delete a case edge to drop the case. The node panel's Cases list does the same in
list form. Both go through `switchCases.ts`, the one place `node.data.cases` is read.

---

### `for` — control · has a nested scope (`do`)

```ts
node.data = {
  label: string
  each:  string   // variable name for current item, e.g. "item"
  at:    string   // variable name for index, e.g. "index"
  in:    string   // ExpressionInput — must resolve to array
  while: string   // ConditionBuilder — optional early-exit condition
  ...DataFlow
}
```

Iterates over the array returned by `in`. Click **"Edit loop body"** to author the per-iteration task list in its own drill-in scope.

---

### `fork` — control · has a nested scope per branch

```ts
node.data = {
  label:    string
  compete:  boolean       // if true, only the fastest branch result is kept
  branches: BranchEntry[] // explicit named branches — NOT inferred from canvas edges
  ...DataFlow
}

interface BranchEntry {
  id:   string   // stable drill-in scope key, independent of `name`
  name: string   // DSL branch/task name
}
```

Branches are explicit data entries (add/rename/remove in the panel), each with its own "Edit body" drill-in button — this replaced the old edge-inference model, which doesn't compose with drill-in scopes since branch bodies are no longer sibling canvas nodes.

---

### `try` — control · has two nested scopes (`try`, `catch`)

```ts
node.data = {
  label:   string
  catchAs: string   // variable name for the error object, e.g. "error"
  ...DataFlow
}
```

Two separate drill-in buttons — "Edit try body" and "Edit catch body" — each opening its own scope. The caught error is available as `${ $data.<catchAs> }` inside the catch body.

---

### `wait` — event

```ts
node.data = {
  label:    string
  waitMode: 'duration' | 'until'
  days: number; hours: number; minutes: number; seconds: number   // duration mode
  until: string   // ExpressionInput — RFC 3339 timestamp — until mode
  ...DataFlow
}
```

Durable timer. `waitMode` selects one of the two mutually-exclusive DSL shapes (`wait.until` vs. the duration fields).

---

### `listen` — event

```ts
node.data = {
  label:    string
  strategy: 'all' | 'any' | 'one'
  events:   EventEntry[]
  ...DataFlow
}

interface EventEntry {
  id:       string
  type:     'signal' | 'query' | 'update'
  data?:    string
  acceptIf?: string   // ConditionBuilder — filter on event payload
}
```

`strategy: 'one'` serializes `listen.to.one` as a **single object**, not a list — `'all'`/`'any'` serialize as arrays. (Earlier versions of the DSL generator got this wrong for `'one'`.)

---

### `raise` — event

```ts
node.data = {
  label:          string
  errorType:      string   // URI — RFC 7807 type
  errorStatus:    number   // HTTP status code
  errorTitle?:    string
  errorDetail?:   string   // ExpressionInput
  errorInstance?: string   // JSON Pointer — now surfaced in the panel and emitted in the DSL
  ...DataFlow
}
```

Throws a typed RFC 7807 error. Terminates the current execution path unless caught by a `try`.

---

### `run` — action (BYOC)

```ts
node.data = {
  label:   string
  runType: 'script' | 'shell' | 'container' | 'workflow'
  language: 'js' | 'python'; code: string        // script
  command: string                                 // shell (CodeMirror shell mode)
  image: string; pullPolicy: 'ifNotPresent' | 'always' | 'never'   // container — lowercase only
  workflowType: string                            // workflow
  ...DataFlow
}
```

Bring Your Own Code. `code`/`command` use `CodeMirrorEditor` (JS/Python/shell modes). `pullPolicy` is a lowercase-only enum (`ifNotPresent`/`always`/`never`) — an earlier version of the panel offered capitalized `Always`/`Never`, which failed schema validation.

---

### `childWorkflow` — structure

```ts
node.data = {
  label:        string
  workflowType: string   // Temporal workflow type name
  childInput:   string   // ExpressionInput — defaults to "${ . }"
  await:        boolean  // if false, fire-and-forget
  ...DataFlow
}
```

Invokes another registered workflow (`run: { workflow: {...} }` in the DSL). Note: Zigflow's `run.workflow.input` must be a JSON object (unlike `output.as`/`export.as`, it has no runtime-expression string form) — a customized `childInput` expression is wrapped as `{ value: <expr> }` on serialize so the emitted DSL stays schema-valid; the default `${ . }` is omitted entirely.

---

### `workflow` — terminal · has a nested scope, shown in the palette as "Start"

```ts
node.data = { label: string, variables: VarEntry[], ...DataFlow };
```

A whole separate Temporal workflow declared in the same document, emitted as a root-level
`<label>: do: [...]`. This is zigflow's own model, verifiable with the CLI: `zigflow graph` draws
each root-level `do:` task as its own subgraph with its own Start and End, and the primary workflow
(the root tasks that aren't `do:` tasks) as another, named by `document.workflowType`.

The node **is** that workflow's Start, which is why the palette calls it Start and why it carries
`variables` exactly like the primary `start` node does — emitted as a leading `init: set:` inside
its own `do:`, and read back as an ordinary `set` node, same as the primary workflow's. The label is
its whole identity (the DSL task key, the Temporal workflow type, and what a switch case's `then:`
names), so dropping one from the palette asks for it immediately (`WorkflowNameDialog`) and
cancelling removes the node.

It never joins the primary chain: no edges are wired to it, `scopeToTaskList` emits these after the
chain, and `positionChain` gives each its own column with its body running straight down beneath it.
The frame around the pair carries no title and no start cap — the Start card is both.

Only the **root** produces these; a `do:` task nested in a `for`/`try`/`fork` body is a plain group
(`do` node, below).

---

### `do` — structure · has a nested scope (`do`)

```ts
node.data = { label: string, ...DataFlow };
```

A named group of steps run in sequence, emitted as `<label>: do: [...]`. Not in the palette: at the
root a `do:` task is a whole workflow (above), so these only arrive from hand-written DSL that groups
steps inside a `for`/`try`/`fork` body. Its body is the lane keyed by `forScopeKey`, framed and
capped like every other lane.

---

## Key Types (`builderConfig.ts`)

```ts
interface VarEntry {
	key: string;
	value: string;
}
interface CaseEntry {
	id: string;
	name: string;
	condition: string;
	routing: CaseRouting; // 'task' | 'continue' | 'exit' | 'end'
	taskName?: string;
	targetNodeId?: string;
}
interface EventEntry {
	id: string;
	type: 'signal' | 'query' | 'update';
	data?: string;
	acceptIf?: string;
}
interface BranchEntry {
	id: string;
	name: string;
}
interface DataFlow {
	if: string;
	outputAs: string;
	exportAs: string;
}
type NestedScopeKind = 'do' | 'try-catch' | 'fork-branches';
```

## Key Components

| Component          | File                                                | Used for                                                                                                           |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ExpressionInput`  | `ExpressionInput.svelte`                            | Chip-based expression builder, all `${ }` fields                                                                   |
| `ConditionBuilder` | `ConditionBuilder.svelte`                           | Visual jq condition builder, used for the shared "Run only if" guard, Switch cases, For `while`, Listen `acceptIf` |
| `NodePanel`        | `NodePanel.svelte`                                  | Right-side config panel — hosts all node editors, the shared guard/data-flow sections, and drill-in entry points   |
| `CodeMirrorEditor` | `src/lib/components/editor/CodeMirrorEditor.svelte` | Thin CodeMirror 6 wrapper (YAML/JSON/JS/Python/shell), theme-reactive via `theme.svelte.ts`                        |

`ExpressionInput` emits `${ expr }` format. `ConditionBuilder` emits `${ left op right [and/or ...] }` and uses `ExpressionInput` internally for the left/right operands. Neither's autocomplete/suggestion logic or styling should be changed without explicit direction — they're reused as-is throughout.

---

## Engine Module

`src/lib/zigflow-engine/` is a plain-TypeScript, UI-independent library (no Svelte imports) responsible for everything DSL-shaped:

| File                         | Responsibility                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `schema/zigflow.schema.json` | Copy of the published Zigflow JSON Schema (draft 2020-12) — bundled, not fetched at runtime                                    |
| `ast.ts`                     | Discriminated-union TypeScript types mirroring the schema's 11 real task types + shared `TaskBase`                             |
| `validate.ts`                | `ajv`-based grammar validation (`validateZigflowDocument`)                                                                     |
| `serialize.ts`               | AST → plain object tree → YAML text (via the `yaml` package, with explicit block-literal styling for multiline scripts/bodies) |
| `deserialize.ts`             | YAML text → parse → validate → AST, with structured errors mapped back to YAML source ranges                                   |
| `graph.ts`                   | Bidirectional AST ⟷ per-scope `{nodes, edges}` conversion — the core of drill-in navigation                                    |
| `layout.ts`                  | Minimal auto-layout for a scope's nodes (no `dagre`/`elkjs` dependency — every scope is a simple chain)                        |
| `scopeKey.ts`                | Deterministic scope-id builders shared by `graph.ts` and the Svelte layer                                                      |
| `slug.ts`                    | Task-name slugging helpers                                                                                                     |

Each module has co-located `*.test.ts` unit tests (run under the vitest `server` project — no Svelte/browser dependency). The Svelte layer (`+page.svelte`, `NodePanel.svelte`) only calls the public functions (`serializeZigflowDocument`, `deserializeZigflowDocument`, `astToGraph`, `graphToAst`) — it never constructs YAML strings or task objects by hand.
