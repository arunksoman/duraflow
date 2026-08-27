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
- A `switch` task's `then` can only jump to a task name within the **same scope** (per the DSL spec) — the "then" dropdown in the Switch panel is scoped accordingly.
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
  name:      string   // case identifier (used as DSL step name)
  condition: string   // ConditionBuilder — blank = default/fallthrough
  then:      string   // 'continue' | 'end' | 'exit' | node.id (same scope only)
}
```

This is the **real** conditional-branching construct in Zigflow (not a dedicated "If" node). Cases evaluated top-to-bottom, first truthy match wins.

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

### `do` — control · has a nested scope (`do`)

```ts
node.data = { label: string, ...DataFlow };
```

Sequential task group. `showInPalette: false` — not manually added from the palette, but shown (with a drill-in button) when hand-written/imported DSL uses an explicit grouping `do:` task outside a `for`/`fork`/`try` context.

---

## Key Types (`builderConfig.ts`)

```ts
interface VarEntry {
	key: string;
	value: string;
}
interface CaseEntry {
	name: string;
	condition: string;
	then: string;
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
