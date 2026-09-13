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

/**
 * One execution of a node. A node runs more than once when it is retried, sits inside a loop, or
 * is jumped back to — each of those is its own attempt, with its own input and output, so a loop's
 * third iteration can be inspected without being overwritten by the fourth.
 */
export interface NodeAttempt {
	/** Seq of the first event of this attempt — orders attempts across the whole run. */
	seq: number;
	state: Exclude<NodeRunState, 'pending' | 'skipped'>;
	/** Where it ran: "" at the root, "for_2" for a loop's third iteration, and so on. */
	scopePath: string;
	scopeLabel: string;
	input?: unknown;
	output?: unknown;
	/** Workflow state as the task started, and as it finished — the variables flowing through it. */
	stateBefore?: unknown;
	stateAfter?: unknown;
	error?: string;
	startedAt?: string;
	endedAt?: string;
	/** zigflow's own retry counter, when it reported one. */
	retry?: number;
	truncated?: boolean;
}

export interface NodeRunDetail {
	state: NodeRunState;
	/** Times this node started — >1 means a retry or a loop iteration. */
	attempts: number;
	/** Every execution of this node, oldest first. The flat fields below mirror the latest one. */
	history: NodeAttempt[];
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
		byNode[nodeId] = emptyDetail();
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

		// Every `for` iteration, `fork` branch and `try` block is its own child workflow and reports
		// its own start/finish; only the root scope's describe the run as a whole.
		if (event.eventType === 'workflow.started') {
			if (!event.scopePath) workflowInput = data.input;
			continue;
		}
		if (event.eventType === 'workflow.completed') {
			if (!event.scopePath) workflowOutput = data.output;
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

		byNode[match.nodeId] = applyEvent(byNode[match.nodeId] ?? emptyDetail(), event, scopePath);
	}

	return { ...state, byNode, log, unmatched, workflowInput, workflowOutput, lastSeq };
}

function emptyDetail(): NodeRunDetail {
	return { state: 'pending', attempts: 0, history: [] };
}

function applyEvent(
	detail: NodeRunDetail,
	event: ExecutionEvent,
	scopePath: string
): NodeRunDetail {
	const data = event.data ?? {};
	const next: NodeRunDetail = { ...detail, scopePath };
	const history = [...detail.history];

	switch (event.eventType) {
		case 'task.started': {
			next.state = detail.state === 'error' ? 'error' : 'running';
			next.attempts = detail.attempts + 1;
			next.startedAt = event.occurredAt;
			if ('input' in data) next.input = data.input;
			if ('state' in data) next.taskState = data.state;
			// A re-run (loop iteration, retry, back-jump) reports its own result; drop the stale one.
			next.output = undefined;

			history.push({
				...newAttempt(event, scopePath),
				...('input' in data ? { input: data.input } : {}),
				...('state' in data ? { stateBefore: data.state } : {}),
				...(event.attempt ? { retry: event.attempt } : {})
			});
			break;
		}

		case 'task.retried': {
			next.state = 'running';
			next.attempts = Math.max(next.attempts, event.attempt ?? next.attempts + 1);
			const i = openAttemptIndex(history, event, scopePath);
			history[i] = { ...history[i], state: 'running', retry: event.attempt ?? history[i].retry };
			break;
		}

		case 'task.completed': {
			next.state = 'success';
			next.endedAt = event.occurredAt;
			if ('input' in data) next.input = data.input;
			if ('output' in data) next.output = data.output;
			if ('state' in data) next.taskState = data.state;
			next.error = undefined;

			const i = openAttemptIndex(history, event, scopePath);
			history[i] = {
				...history[i],
				state: 'success',
				endedAt: event.occurredAt,
				error: undefined,
				...('input' in data ? { input: data.input } : {}),
				...('output' in data ? { output: data.output } : {}),
				...('state' in data ? { stateAfter: data.state } : {}),
				...(event.truncated ? { truncated: true } : {})
			};
			break;
		}

		case 'task.faulted':
		case 'task.cancelled': {
			next.state = 'error';
			next.endedAt = event.occurredAt;
			next.error =
				typeof data.error === 'string'
					? data.error
					: event.eventType === 'task.cancelled'
						? 'Task cancelled'
						: 'Task failed';

			const i = openAttemptIndex(history, event, scopePath);
			history[i] = {
				...history[i],
				state: 'error',
				endedAt: event.occurredAt,
				error: next.error,
				...('state' in data ? { stateAfter: data.state } : {})
			};
			break;
		}

		case 'iteration.completed':
			// The loop node itself stays running until its own task.completed arrives.
			break;
	}

	next.history = history;
	return next;
}

function newAttempt(event: ExecutionEvent, scopePath: string): NodeAttempt {
	return {
		seq: event.seq,
		state: 'running',
		scopePath,
		scopeLabel: describeScopePath(scopePath),
		startedAt: event.occurredAt,
		...(event.truncated ? { truncated: true } : {})
	};
}

/**
 * The attempt a finishing event closes: the latest still-open one in the same scope. Scope matters
 * because a fork's branches, or a loop iteration's nested scopes, can interleave. A finish with no
 * matching start (its start was pruned or never sent) opens an attempt of its own, pushed in place.
 */
function openAttemptIndex(
	history: NodeAttempt[],
	event: ExecutionEvent,
	scopePath: string
): number {
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].scopePath === scopePath && history[i].state === 'running') return i;
	}
	history.push(newAttempt(event, scopePath));
	return history.length - 1;
}

/** One executed node, in the order the run reached it — the path the run took, step by step. */
export interface RunStep {
	nodeId: string;
	attemptIndex: number;
	attempt: NodeAttempt;
}

export function buildRunSteps(state: RunState): RunStep[] {
	const steps: RunStep[] = [];
	for (const [nodeId, detail] of Object.entries(state.byNode)) {
		detail.history.forEach((attempt, attemptIndex) =>
			steps.push({ nodeId, attemptIndex, attempt })
		);
	}
	return steps.sort((a, b) => a.attempt.seq - b.attempt.seq);
}

/** Keys zigflow keeps in `state.data` for its own bookkeeping, not variables the workflow set. */
const RUNTIME_DATA_KEYS = new Set(['task', 'workflow']);

/**
 * The variables a workflow has at a point in time, from the `state` zigflow attaches to a task
 * event: `$data` without the runtime's own `task`/`workflow` metadata (which changes on every task
 * and would drown out real changes), plus `$context` when the workflow has exported any.
 * Anything not shaped like zigflow state is returned unchanged.
 */
export function workflowVariables(state: unknown): unknown {
	if (typeof state !== 'object' || state === null || !('data' in state)) return state;
	const { data, context } = state as { data?: unknown; context?: unknown };

	const variables: Record<string, unknown> =
		typeof data === 'object' && data !== null && !Array.isArray(data)
			? Object.fromEntries(Object.entries(data).filter(([key]) => !RUNTIME_DATA_KEYS.has(key)))
			: {};
	if (context !== null && context !== undefined) variables.$context = context;
	return variables;
}

export type ValueChangeKind = 'added' | 'changed' | 'removed';

export interface ValueChange {
	/** Dotted path from the root, with `[i]` for array indexes — "context.user.name", "items[2]". */
	path: string;
	kind: ValueChangeKind;
	before?: unknown;
	after?: unknown;
}

/**
 * What a task did to the data flowing through it: every leaf that appeared, changed or vanished
 * between `before` and `after`. Descends into objects up to `maxDepth`; below that — and into
 * arrays, whose elements are compared whole — a difference is reported at the containing path, so a
 * big payload yields a readable list instead of thousands of leaves.
 */
export function diffValues(before: unknown, after: unknown, maxDepth = 4): ValueChange[] {
	const changes: ValueChange[] = [];
	walkDiff(before, after, '', maxDepth, changes);
	return changes;
}

function walkDiff(
	before: unknown,
	after: unknown,
	path: string,
	depth: number,
	changes: ValueChange[]
) {
	if (isPlainObject(before) && isPlainObject(after) && depth > 0) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		for (const key of keys) {
			const childPath = path ? `${path}.${key}` : key;
			if (!(key in before)) {
				changes.push({ path: childPath, kind: 'added', after: after[key] });
			} else if (!(key in after)) {
				changes.push({ path: childPath, kind: 'removed', before: before[key] });
			} else {
				walkDiff(before[key], after[key], childPath, depth - 1, changes);
			}
		}
		return;
	}

	if (before === undefined && after === undefined) return;
	if (before === undefined) {
		changes.push({ path, kind: 'added', after });
	} else if (after === undefined) {
		changes.push({ path, kind: 'removed', before });
	} else if (!sameValue(before, after)) {
		changes.push({ path, kind: 'changed', before, after });
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
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
			const closed = status === 'completed' ? 'unknown' : 'error';
			const error = detail.error ?? (status === 'completed' ? undefined : `Run ${status}`);
			byNode[nodeId] = {
				...detail,
				state: closed,
				error,
				history: detail.history.map((attempt) =>
					attempt.state === 'running' ? { ...attempt, state: closed, error } : attempt
				)
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

	const detail = state.byNode[match.nodeId] ?? emptyDetail();
	return {
		...state,
		byNode: { ...state.byNode, [match.nodeId]: { ...detail, childExecutionId } }
	};
}
