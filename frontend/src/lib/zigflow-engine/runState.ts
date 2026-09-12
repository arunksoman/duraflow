import type { ExecutionEvent, ExecutionStatus } from '../types';
import type { RunIndex } from './runIndex';
import { describeScopePath, resolveNode, type MatchConfidence } from './runScope';

/**
 * Folds a run's event stream into per-node state and a readable log. Pure and UI-free, so the
 * builder's live canvas and the execution detail page's replay produce identical results from
 * identical events.
 *
 * The important state here is `skipped`: once a run has finished, every node that never received
 * an event did not execute. That is what makes the untaken side of a `switch`, a task whose `if:`
 * was false, and everything after a failure visibly distinct from the path the run actually took.
 */

export type NodeRunState = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'unknown';

export interface NodeRunDetail {
	state: NodeRunState;
	/** Times this node started — >1 means a retry or a loop iteration. */
	attempts: number;
	input?: unknown;
	output?: unknown;
	/** The workflow state zigflow captured alongside the task, for debugging expressions. */
	taskState?: unknown;
	error?: string;
	startedAt?: string;
	endedAt?: string;
	scopePath?: string;
	/** Set on a `childWorkflow` node once its child run has been discovered. */
	childExecutionId?: string;
}

export interface RunLogEntry {
	seq: number;
	eventType: string;
	taskName: string;
	scopePath: string;
	scopeLabel: string;
	nodeId: string | null;
	confidence: MatchConfidence;
	occurredAt: string;
	attempt?: number;
	error?: string;
	truncated?: boolean;
	data?: Record<string, unknown>;
}

export interface RunState {
	byNode: Record<string, NodeRunDetail>;
	log: RunLogEntry[];
	/** Events whose task couldn't be matched to a node — surfaced rather than silently dropped. */
	unmatched: RunLogEntry[];
	workflowInput?: unknown;
	workflowOutput?: unknown;
	lastSeq: number;
	finalized: boolean;
}

export function initialRunState(index: RunIndex): RunState {
	const byNode: Record<string, NodeRunDetail> = {};
	for (const nodeId of index.allNodeIds) {
		byNode[nodeId] = { state: 'pending', attempts: 0 };
	}
	return { byNode, log: [], unmatched: [], lastSeq: 0, finalized: false };
}

export function reduceRunState(state: RunState, event: ExecutionEvent, index: RunIndex): RunState {
	return reduceRunStateAll(state, [event], index);
}

/** Applies a batch of events in one pass — the replay path for a finished run. */
export function reduceRunStateAll(
	state: RunState,
	events: ExecutionEvent[],
	index: RunIndex
): RunState {
	if (events.length === 0) return state;

	const byNode = { ...state.byNode };
	const log = [...state.log];
	const unmatched = [...state.unmatched];
	let { workflowInput, workflowOutput, lastSeq } = state;

	for (const event of events) {
		if (event.seq <= lastSeq) continue;
		lastSeq = event.seq;

		const data = event.data ?? {};

		if (event.eventType === 'workflow.started') {
			workflowInput = data.input;
			continue;
		}
		if (event.eventType === 'workflow.completed') {
			workflowOutput = data.output;
			continue;
		}

		const taskName = event.taskName ?? '';
		const scopePath = event.scopePath ?? '';
		const match = resolveNode(index, scopePath, taskName);

		const entry: RunLogEntry = {
			seq: event.seq,
			eventType: event.eventType,
			taskName,
			scopePath,
			scopeLabel: describeScopePath(scopePath),
			nodeId: match.nodeId,
			confidence: match.confidence,
			occurredAt: event.occurredAt,
			...(event.attempt ? { attempt: event.attempt } : {}),
			...(typeof data.error === 'string' ? { error: data.error } : {}),
			...(event.truncated ? { truncated: true } : {}),
			data
		};
		log.push(entry);

		if (!match.nodeId) {
			unmatched.push(entry);
			continue;
		}

		byNode[match.nodeId] = applyEvent(
			byNode[match.nodeId] ?? { state: 'pending', attempts: 0 },
			event,
			scopePath
		);
	}

	return { ...state, byNode, log, unmatched, workflowInput, workflowOutput, lastSeq };
}

function applyEvent(detail: NodeRunDetail, event: ExecutionEvent, scopePath: string): NodeRunDetail {
	const data = event.data ?? {};
	const next: NodeRunDetail = { ...detail, scopePath };

	switch (event.eventType) {
		case 'task.started':
			next.state = detail.state === 'error' ? 'error' : 'running';
			next.attempts = detail.attempts + 1;
			next.startedAt = event.occurredAt;
			if ('input' in data) next.input = data.input;
			if ('state' in data) next.taskState = data.state;
			// A re-run (loop iteration, retry, back-jump) reports its own result; drop the stale one.
			next.output = undefined;
			break;

		case 'task.retried':
			next.state = 'running';
			next.attempts = Math.max(next.attempts, event.attempt ?? next.attempts + 1);
			break;

		case 'task.completed':
			next.state = 'success';
			next.endedAt = event.occurredAt;
			if ('input' in data) next.input = data.input;
			if ('output' in data) next.output = data.output;
			if ('state' in data) next.taskState = data.state;
			next.error = undefined;
			break;

		case 'task.faulted':
		case 'task.cancelled':
			next.state = 'error';
			next.endedAt = event.occurredAt;
			next.error =
				typeof data.error === 'string'
					? data.error
					: event.eventType === 'task.cancelled'
						? 'Task cancelled'
						: 'Task failed';
			break;

		case 'iteration.completed':
			// The loop node itself stays running until its own task.completed arrives.
			break;
	}

	return next;
}

/**
 * Closes out a run: anything still `pending` never executed. Call this once the run has reached a
 * terminal status — it is what turns "we haven't heard about this node yet" into "this node was
 * not on the path taken".
 */
export function finalizeRunState(state: RunState, status: ExecutionStatus): RunState {
	const byNode: Record<string, NodeRunDetail> = {};
	for (const [nodeId, detail] of Object.entries(state.byNode)) {
		if (detail.state === 'pending') {
			byNode[nodeId] = { ...detail, state: 'skipped' };
		} else if (detail.state === 'running') {
			// The run ended while this node was still open: it didn't finish, whatever the reason.
			byNode[nodeId] = {
				...detail,
				state: status === 'completed' ? 'unknown' : 'error',
				error: detail.error ?? (status === 'completed' ? undefined : `Run ${status}`)
			};
		} else {
			byNode[nodeId] = detail;
		}
	}
	return { ...state, byNode, finalized: true };
}

/** Attaches a discovered child run to the `childWorkflow` node whose task started it. */
export function attachChildExecution(
	state: RunState,
	index: RunIndex,
	parentTaskName: string,
	parentScopePath: string,
	childExecutionId: string
): RunState {
	const match = resolveNode(index, parentScopePath, parentTaskName);
	if (!match.nodeId) return state;

	const detail = state.byNode[match.nodeId] ?? { state: 'pending' as NodeRunState, attempts: 0 };
	return {
		...state,
		byNode: { ...state.byNode, [match.nodeId]: { ...detail, childExecutionId } }
	};
}
