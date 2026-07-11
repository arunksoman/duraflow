# Node Reference — Duraflow Builder

All nodes live in `src/lib/components/builder/`. Node types are defined in `builderConfig.ts`. The panel UI is in `NodePanel.svelte`. The DSL serializer reads `node.data` and emits gojq-compatible YAML.

---

## Runtime Variables

These are available in every `ExpressionInput` / `ConditionBuilder` field:

| Ref | Source | Notes |
|-----|--------|-------|
| `$input` | Workflow trigger payload | Fields from `workflowMeta.inputSchema` |
| `$env` | Environment variables | From `workflowMeta.envVars` |
| `.` | Current task input (shorthand for `$input`) | Always available |
| `$output` | Previous task's full output | Available after at least one task |
| `$data.<key>` | Mutable store | Written by `start.variables`, `set.variables`, `if.variables` |
| `$context` | Accumulated exports | Written by `exportAs` on any upstream node |

---

## Data Flow Fields (on every node except `start` / `end`)

```ts
interface DataFlow {
  inputFrom: string  // jq — override what . is for this node
  outputAs:  string  // jq — reshape $output before passing downstream
  exportAs:  string  // jq — merge result into $context
}
```

All three accept `ExpressionInput` format (`${ expr }`).

---

## Nodes

### `start` — terminal

```ts
node.data = {
  label:     string
  variables: VarEntry[]   // { key: string, value: string }
}
```

- `variables` initialises `$data` keys before the first task runs.
- Values accept `ExpressionInput` format.
- No `DataFlow` fields.
- `showInPalette: false` — auto-created, one per workflow.

---

### `end` — terminal

```ts
node.data = { label: string }
```

No config. Terminates the workflow path. No `DataFlow` fields.

---

### `call` — action (REST)

```ts
node.data = {
  label:    string
  method:   'get' | 'post' | 'put' | 'patch' | 'delete'
  endpoint: string              // ExpressionInput
  headers:  VarEntry[]
  query:    VarEntry[]
  body:     string              // ExpressionInput (multiline)
  output:   'content' | 'raw' | 'response'
  redirect: boolean
  ...DataFlow
}
```

- `endpoint`, header values, query values, and `body` all accept `ExpressionInput`.
- `output` controls what becomes `$output`:
  - `content` — deserialized JSON body (default)
  - `raw` — base64-encoded bytes
  - `response` — full HTTP response object
- HTTP error handling: 4xx → non-retryable, 5xx / 408 / 429 → retryable.

---

### `task` — action (Temporal activity)

```ts
node.data = {
  label:    string
  method:   'get' | 'post' | 'put' | 'patch' | 'delete'
  endpoint: string   // ExpressionInput
  timeout:  string   // e.g. "30s"
  ...DataFlow
}
```

Named Temporal activity invoked via HTTP. Simpler than `call` — no headers/body config. Timeout string uses Go duration format (`30s`, `5m`).

---

### `set` — action

```ts
node.data = {
  label:     string
  variables: VarEntry[]   // written into $data
  ...DataFlow
}
```

Writes key-value pairs into `$data`. Values accept `ExpressionInput`. Keys are accessible as `${ $data.<key> }` in all downstream nodes.

> Special jq builtins available here: `${ uuid }`, `${ timestamp }` — not in other fields.

---

### `if` — control

```ts
node.data = {
  label:     string
  condition: string       // ConditionBuilder — gojq expression
  variables: VarEntry[]   // written into $data when condition is truthy
  ...DataFlow
}
```

- `condition` is built with `ConditionBuilder`, serialized as `${ left op right }`.
- Empty condition → always runs (no filter).
- `variables` run only when the condition is truthy.
- Outgoing edges are not branched — the node either proceeds or skips.

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
  then:      string   // 'continue' | 'end' | 'exit' | node.id
}
```

- Cases evaluated top-to-bottom. First truthy match wins.
- `then` resolves: `continue` (next task), `end` (terminate), `exit` (leave scope), or a `node.id` which the DSL serializer converts to the node's slug.
- Blank `condition` → acts as a default case.

---

### `for` — control

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

- Iterates over the array returned by `in`.
- Each iteration injects `$data.<each>` and `$data.<at>` (zero-based index).
- `while` condition is checked before each iteration; loop exits when falsy.
- Each iteration runs as a Temporal child workflow internally.

---

### `fork` — control

```ts
node.data = {
  label:   string
  compete: boolean   // if true, only the fastest branch result is kept
  ...DataFlow
}
```

- Branches are inferred from outgoing edges — no explicit branch config.
- `compete: false` → wait for all branches, merge results.
- `compete: true` → return output of whichever branch finishes first, cancel others.

---

### `try` — control

```ts
node.data = {
  label:   string
  catchAs: string   // variable name for the error object, e.g. "error"
  ...DataFlow
}
```

- Wraps child tasks in a try/catch scope.
- On any error, the catch branch runs and the error object is available as `${ $data.<catchAs> }`.
- The error object shape follows RFC 7807 Problem Details.

---

### `wait` — event

```ts
node.data = {
  label:    string
  waitMode: 'duration' | 'until'
  // duration mode:
  days:     number
  hours:    number
  minutes:  number
  seconds:  number
  // until mode:
  until:    string   // ExpressionInput — RFC 3339 timestamp
  ...DataFlow
}
```

- Durable timer backed by Temporal. Survives process restarts.
- `until` accepts expressions, e.g. `${ $data.deadline }`.
- Past `until` timestamp → no-op, execution continues immediately.

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
  id:       string                          // Temporal signal/query/update name
  type:     'signal' | 'query' | 'update'
  data?:    string
  acceptIf?: string   // ConditionBuilder — filter on event payload
}
```

- `strategy`:
  - `one` — resolve on first matching event
  - `any` — resolve when any event arrives
  - `all` — wait until all listed events have arrived
- `acceptIf` filters incoming event payloads before accepting.

---

### `raise` — event

```ts
node.data = {
  label:         string
  errorType:     string   // URI — RFC 7807 type
  errorStatus:   number   // HTTP status code
  errorTitle?:   string
  errorDetail?:  string   // ExpressionInput
  errorInstance?: string
  ...DataFlow
}
```

Throws a typed error following RFC 7807 Problem Details. Terminates the current execution path. The error propagates to the nearest `try` catch block, or fails the workflow if uncaught.

---

### `run` — action (BYOC)

```ts
node.data = {
  label:   string
  runType: 'script' | 'shell' | 'container' | 'workflow'
  // script:
  language: 'js' | 'python'
  code:     string
  // shell:
  command:  string
  // container:
  image:      string
  pullPolicy: 'ifNotPresent' | 'Always' | 'Never'
  // workflow:
  workflowType: string
  ...DataFlow
}
```

Bring Your Own Code. Four sub-types selectable in the panel. Input is available via `process.env.INPUT` (scripts) or the container's stdin. Output is whatever the code writes to stdout (parsed as JSON if possible).

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

Invokes another registered workflow as a Temporal child workflow. `await: true` blocks until the child completes and uses its result as `$output`. `await: false` starts the child and immediately continues.

---

### `do` — control (internal)

```ts
node.data = { label: string, ...DataFlow }
```

Sequential task group. `showInPalette: false` — created internally by the DSL serializer to group tasks, not added manually by users.

---

## Key Types

```ts
// builderConfig.ts
interface VarEntry   { key: string; value: string }
interface CaseEntry  { name: string; condition: string; then: string }
interface EventEntry { id: string; type: 'signal'|'query'|'update'; data?: string; acceptIf?: string }
interface DataFlow   { inputFrom: string; outputAs: string; exportAs: string }
```

## Key Components

| Component | File | Used for |
|-----------|------|----------|
| `ExpressionInput` | `ExpressionInput.svelte` | Chip-based expression builder, all `${ }` fields |
| `ConditionBuilder` | `ConditionBuilder.svelte` | Visual jq condition builder for `if`, `switch`, `for.while`, `listen.acceptIf` |
| `NodePanel` | `NodePanel.svelte` | Right-side config panel, hosts all node editors |

`ExpressionInput` emits `${ expr }` format. `ConditionBuilder` emits `${ left op right [and/or ...] }` and uses `ExpressionInput` internally for the left/right operands.
