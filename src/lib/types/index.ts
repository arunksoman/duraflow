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

export interface Execution {
	id: string;
	workflowId: string;
	workflowName: string;
	status: ExecutionStatus;
	startedAt: string;
	completedAt?: string;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	parentExecutionId?: string;
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
	description?: string;
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
