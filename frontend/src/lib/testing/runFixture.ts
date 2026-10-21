// Test-only: a small workflow plus a recorded run of it, for the run views.
import { astToGraph, type ScopeGraph } from '$lib/zigflow-engine/graph';
import { buildRunIndex, scopeNameKey, type RunIndex } from '$lib/zigflow-engine/runIndex';
import { ROOT_SCOPE_ID } from '$lib/zigflow-engine/scopeKey';
import type { ZigflowDocument } from '$lib/zigflow-engine/ast';
import type { ExecutionEvent } from '$lib/types';

/** `prepare` runs twice (two loop-style attempts), `notify` fails, `archive` never runs. */
export const fixtureDoc = {
	document: { dsl: '1.0.0', taskQueue: 'q', workflowType: 'orders', version: '0.1.0' },
	do: [
		{ prepare: { set: { total: 1 } } },
		{ notify: { set: { sent: true } } },
		{ archive: { set: { done: true } } },
		{ callChild: { run: { workflow: { type: 'child' } } } }
	]
} as unknown as ZigflowDocument;

export interface RunFixture {
	scopes: Record<string, ScopeGraph>;
	index: RunIndex;
	nodeIdOf: (taskName: string) => string;
}

export function runFixture(doc: ZigflowDocument = fixtureDoc): RunFixture {
	const { graph } = astToGraph(doc);
	const index = buildRunIndex(graph);
	return {
		scopes: graph.scopes,
		index,
		nodeIdOf: (name) => index.byScopeAndName.get(scopeNameKey(ROOT_SCOPE_ID, name))!
	};
}

let seq = 0;
export function event(
	eventType: string,
	taskName: string | undefined,
	data: Record<string, unknown> = {},
	extra: Partial<ExecutionEvent> = {}
): ExecutionEvent {
	seq++;
	return {
		seq,
		executionId: 'e1',
		workflowExecutionId: 'e1',
		occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		eventType,
		taskName,
		data,
		...extra
	} as ExecutionEvent;
}

/** A failed run: input, two attempts of `prepare` (the second changes state), `notify` faults. */
export function fixtureEvents(): ExecutionEvent[] {
	return [
		event('workflow.started', undefined, { input: { orderId: 7 } }),
		event('task.started', 'prepare', { input: { n: 1 }, state: { data: { total: 0 } } }),
		event('task.completed', 'prepare', { output: { n: 1 }, state: { data: { total: 0 } } }),
		event('task.started', 'prepare', { input: { n: 2 }, state: { data: { total: 0, gone: 1 } } }),
		event('task.completed', 'prepare', {
			output: { n: 2 },
			state: { data: { total: 5, added: 'x'.repeat(100) } }
		}),
		event('task.started', 'notify', { input: {} }),
		event('task.faulted', 'notify', { error: 'smtp down' }),
		event('task.started', 'ghost', {})
	];
}
