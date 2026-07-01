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
	| 'task'
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

export interface WorkflowNode {
	id: string;
	type: WorkflowNodeType;
	position: { x: number; y: number };
	data: Record<string, unknown>;
}

export interface WorkflowEdge {
	id: string;
	source: string;
	target: string;
	label?: string;
}

export interface Workflow {
	id: string;
	projectId: string;
	name: string;
	description?: string;
	version: number;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	parentWorkflowId?: string;
	createdAt: string;
	updatedAt: string;
}

export type ExecutionStatus =
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'terminated'
	| 'timed_out';

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
