// Global domain types shared between client and server.

export type Role = 'admin' | 'designer' | 'business';

export interface User {
	id: string;
	email: string;
	name: string;
	role: Role;
	avatarUrl?: string;
}

export interface Session {
	user: User;
	token: string;
	expiresAt: string;
}

export interface Project {
	id: string;
	name: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	workflowCount: number;
}

export type WorkflowNodeType =
	| 'start'
	| 'end'
	| 'call'
	| 'grpcCall'
	| 'do'
	| 'for'
	| 'fork'
	| 'listen'
	| 'raise'
	| 'run'
	| 'set'
	| 'switch'
	| 'try'
	| 'wait'
	| 'childWorkflow';

export interface Workflow {
	id: string;
	projectId: string;
	name: string;
	description?: string;
	version: number;
	/** The persisted Zigflow DSL (YAML) — the canvas is derived from this, not the other way round. */
	dsl: string;
	parentWorkflowId?: string;
	createdAt: string;
	updatedAt: string;
}

export type ExecutionStatus =
	'running' | 'completed' | 'failed' | 'cancelled' | 'terminated' | 'timed_out';

/** What started a run. Only `manual` is produced today; the other two are for the scheduler. */
export type ExecutionTrigger = 'manual' | 'scheduled' | 'backfill';

export interface Execution {
	id: string;
	workflowId: string;
	workflowName: string;
	/** Filled in by the cross-project list endpoint only. */
	projectId?: string;
	projectName?: string;
	status: ExecutionStatus;
	/** Child runs inherit their root run's trigger. */
	trigger: ExecutionTrigger;
	startedAt: string;
	completedAt?: string;
	input?: Record<string, unknown>;
	/** A workflow's `$output` is whatever its last task produced — not necessarily an object. */
	output?: unknown;
	parentExecutionId?: string;
	temporalRunId?: string;
	/** Failure message reported by Temporal once a non-completed run closed. */
	error?: string;
	/** Set only for child runs whose Temporal workflow type matched no stored workflow. */
	workflowType?: string;
	rootExecutionId?: string;
	/** Which task on the parent's canvas started this child run, and where it sits. */
	parentTaskName?: string;
	parentScopePath?: string;
}

/**
 * One moment in a run's timeline, as recorded by the backend from the CloudEvents its zigflow
 * workers emit. Mirrors `executionEventDTO` in backend/internal/api/executions.go.
 */
export interface ExecutionEvent {
	seq: number;
	executionId: string;
	rootExecutionId?: string;
	/** The Temporal workflow execution this came from — a nested scope has its own. */
	workflowExecutionId: string;
	/** "" for the root scope, else "for_0", "try", "fork_<branch>", "for_0_try", … */
	scopePath?: string;
	/** "task.started" | "task.completed" | "task.faulted" | "workflow.completed" | … */
	eventType: string;
	taskName?: string;
	attempt?: number;
	occurredAt: string;
	/** Payload: {input,state} / {input,output,state} / {error} depending on eventType. */
	data?: Record<string, unknown>;
	truncated?: boolean;
}

export type WorkerStatus = 'online' | 'offline' | 'draining';

export interface Worker {
	id: string;
	identity: string;
	taskQueue: string;
	status: WorkerStatus;
	lastHeartbeatAt: string;
}

export interface Schedule {
	id: string;
	workflowId: string;
	cron: string;
	timezone: string;
	enabled: boolean;
	nextRunAt?: string;
}

// ── Workflow Builder ────────────────────────────────────────────────

export interface InputField {
	name: string;
	type: 'string' | 'number' | 'boolean' | 'object' | 'array';
	required?: boolean;
	/** Element type when `type === 'array'` — ignored otherwise. */
	itemsType?: InputField['type'];
	description?: string;
	/** UI-only annotation — not part of the DSL, dropped on every load/save round trip. */
	example?: string;
}

export interface EnvVar {
	/** Name without the ZIGGY_ prefix — e.g. "API_BASE" → ${ $env.API_BASE } */
	name: string;
	description?: string;
	example?: string;
}

export interface WorkflowMeta {
	workflowType: string;
	taskQueue: string;
	version: string;
	inputSchema: InputField[];
	envVars: EnvVar[];
	/**
	 * Passed through from/to `document.title`/`summary`/`tags`/`metadata` so a loaded DSL's
	 * values survive a canvas round-trip even though there's no dedicated editor for them yet.
	 */
	title?: string;
	summary?: string;
	tags?: Record<string, string>;
	metadata?: Record<string, unknown>;
}
