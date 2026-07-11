/**
 * Canonical TypeScript AST for the Zigflow DSL, mirroring
 * `schema/zigflow.schema.json` `$defs` 1:1 (verified against zigflow.dev's
 * published schema, draft 2020-12). Keep this file and the schema in sync —
 * `validate.ts` validates plain objects built from these types against the
 * same schema, so drift between the two produces confusing failures.
 */

// ── Shared primitives ───────────────────────────────────────────────────

/** `${ jq-expression }` — validated by the schema's `runtimeExpression` pattern. */
export type RuntimeExpression = string;

export type FlowDirective = 'continue' | 'exit' | 'end' | (string & {});

export interface DurationFields {
	days?: number | RuntimeExpression;
	hours?: number | RuntimeExpression;
	minutes?: number | RuntimeExpression;
	seconds?: number | RuntimeExpression;
	milliseconds?: number | RuntimeExpression;
}

export interface SchemaDef {
	format?: string;
	document: unknown;
}

export interface InputConfig {
	schema?: SchemaDef;
}

export interface OutputConfig {
	schema?: SchemaDef;
	as?: string | Record<string, unknown>;
}

export interface ExportConfig {
	schema?: SchemaDef;
	as?: string | Record<string, unknown>;
}

/** Shared by every task (`$defs/taskBase`). */
export interface TaskBase {
	if?: RuntimeExpression;
	input?: InputConfig;
	output?: OutputConfig;
	export?: ExportConfig;
	metadata?: Record<string, unknown>;
	then?: FlowDirective;
}

/** `$defs/taskList` — an ordered list of single-key `{ name: task }` maps. */
export type TaskList = Array<Record<string, TaskNode>>;

// ── Call ─────────────────────────────────────────────────────────────────

export interface HttpCallWith {
	method: string;
	endpoint: string;
	headers?: Record<string, string>;
	query?: Record<string, string>;
	body?: unknown;
	output?: 'raw' | 'content' | 'response';
	redirect?: boolean;
}

/**
 * The schema's CallTask is a discriminated union of activity/grpc/http.
 * This app only constructs `http` today (product decision), but keeps the
 * union open so activity/grpc can be added later without a breaking change.
 */
export type CallTask = TaskBase & { call: 'http'; with: HttpCallWith };

// ── Do / For / Fork ──────────────────────────────────────────────────────

export type DoTask = TaskBase & { do: TaskList };

export interface ForConfig {
	each?: string;
	at?: string;
	in: RuntimeExpression;
}

export type ForTask = TaskBase & { for: ForConfig; while?: RuntimeExpression; do: TaskList };

export type ForkTask = TaskBase & {
	fork: { branches: TaskList; compete?: boolean };
};

// ── Listen ───────────────────────────────────────────────────────────────

export interface EventProperties {
	id?: string;
	type?: 'query' | 'signal' | 'update';
	data?: unknown;
	acceptIf?: RuntimeExpression;
}

export interface EventFilter {
	with: EventProperties;
}

export type EventConsumptionStrategy =
	{ all: EventFilter[] } | { any: EventFilter[] } | { one: EventFilter };

export type ListenTask = TaskBase & {
	listen: { to: EventConsumptionStrategy; read?: 'data' | 'envelope' | 'raw' };
};

// ── Raise ────────────────────────────────────────────────────────────────

export interface RaiseError {
	type: string;
	status: number;
	instance?: string;
	title?: string;
	detail?: string;
}

export type RaiseTask = TaskBase & { raise: { error: RaiseError | string } };

// ── Run ──────────────────────────────────────────────────────────────────

export type PullPolicy = 'always' | 'never' | 'ifNotPresent';

export interface ContainerLifetime {
	cleanup: 'always' | 'never';
}

export interface RunContainer {
	image: string;
	pullPolicy: PullPolicy;
	name?: string;
	command?: string;
	volumes?: Record<string, unknown>;
	environment?: Record<string, string>;
	arguments?: string[];
	lifetime?: ContainerLifetime;
}

export interface ExternalResource {
	endpoint: string;
}

export interface RunScript {
	language: 'js' | 'python';
	code?: string;
	source?: ExternalResource;
	arguments?: string[];
	environment?: Record<string, string>;
}

export interface RunShell {
	command: string;
	arguments?: string[];
	environment?: Record<string, string>;
}

export interface RunWorkflow {
	type: string;
	input?: Record<string, unknown>;
}

export type RunConfig =
	| { container: RunContainer }
	| { script: RunScript }
	| { shell: RunShell }
	| { workflow: RunWorkflow };

export type RunTask = TaskBase & { run: RunConfig; await?: boolean };

// ── Set ──────────────────────────────────────────────────────────────────

export type SetTask = TaskBase & { set: Record<string, unknown> };

// ── Switch ───────────────────────────────────────────────────────────────

export interface SwitchCaseBody {
	when?: RuntimeExpression;
	then: FlowDirective;
}

/** One item = `{ [caseName]: SwitchCaseBody }`. */
export type SwitchCase = Record<string, SwitchCaseBody>;

export type SwitchTask = TaskBase & { switch: SwitchCase[] };

// ── Try ──────────────────────────────────────────────────────────────────

export type TryTask = TaskBase & {
	try: TaskList;
	catch: { do: TaskList; as?: string };
};

// ── Wait ─────────────────────────────────────────────────────────────────

export type WaitTask = TaskBase & { wait: DurationFields | { until: string } };

// ── Discriminated union of all 11 real task types ───────────────────────

export type TaskNode =
	| CallTask
	| DoTask
	| ForTask
	| ForkTask
	| ListenTask
	| RaiseTask
	| RunTask
	| SetTask
	| SwitchTask
	| TryTask
	| WaitTask;

// ── Document ─────────────────────────────────────────────────────────────

export interface ZigflowDocumentHeader {
	dsl: string;
	taskQueue: string;
	workflowType: string;
	version: string;
	title?: string;
	summary?: string;
	tags?: Record<string, string>;
	metadata?: Record<string, unknown>;
}

/**
 * The schema allows multiple top-level `do` entries to define multiple
 * independent workflows (see `docs/dsl/tasks/do.md`). This app's canvas only
 * ever authors a single top-level workflow — `do` always has exactly one
 * meaningful entry representing "the" workflow body. Multi-workflow
 * documents are a known, intentional limitation of the visual builder, not
 * silently dropped: `deserialize.ts` should surface a clear error/warning if
 * it encounters more than one top-level `do` entry.
 */
export interface ZigflowDocument {
	document: ZigflowDocumentHeader;
	do: TaskList;
}
