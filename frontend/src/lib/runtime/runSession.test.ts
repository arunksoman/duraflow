// RunSession only owns the connection; runState.ts decides what events mean. These tests drive it
// through a fake EventSource and a stubbed fetch to check the plumbing: reconnects, catch-up,
// late events, child runs and finishing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { astToGraph } from '$lib/zigflow-engine/graph';
import { buildRunIndex, scopeNameKey, type RunIndex } from '$lib/zigflow-engine/runIndex';
import { ROOT_SCOPE_ID } from '$lib/zigflow-engine/scopeKey';
import type { Execution, ExecutionEvent } from '$lib/types';
import { RunSession } from './runSession.svelte';

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	listeners = new Map<string, ((e: MessageEvent) => void)[]>();
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;

	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, fn: (e: MessageEvent) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}

	close() {
		this.closed = true;
	}

	emit(type: string, payload: unknown) {
		const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
		for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data }));
	}

	static latest() {
		return FakeEventSource.instances[FakeEventSource.instances.length - 1];
	}
}

const fetchMock = vi.fn<typeof fetch>();
/** Per-URL-path responses for the stubbed fetch; unknown paths answer 404. */
let routes: Record<string, () => Response>;

beforeEach(() => {
	FakeEventSource.instances = [];
	routes = {};
	fetchMock.mockReset();
	fetchMock.mockImplementation(async (input) => {
		const path = String(input).split('?')[0];
		return routes[path]?.() ?? new Response(null, { status: 404 });
	});
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal('fetch', fetchMock);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function setup(): { index: RunIndex; nodeIdOf: (name: string) => string } {
	const { graph } = astToGraph({
		document: { dsl: '1.0.0', taskQueue: 'q', workflowType: 't', version: '0.1.0' },
		do: [
			{ first: { set: { a: 1 } } },
			{ second: { set: { b: 2 } } },
			{ callChild: { run: { workflow: { type: 'child' } } } }
		]
	} as never);
	const index = buildRunIndex(graph);
	return {
		index,
		nodeIdOf: (name) => index.byScopeAndName.get(scopeNameKey(ROOT_SCOPE_ID, name))!
	};
}

let seq = 0;
function ev(eventType: string, taskName?: string, extra: Partial<ExecutionEvent> = {}) {
	return {
		seq: ++seq,
		executionId: 'e1',
		workflowExecutionId: 'e1',
		occurredAt: '2026-01-01T00:00:00Z',
		eventType,
		taskName,
		...extra
	} as ExecutionEvent;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('RunSession', () => {
	it('starts idle, and clears to "starting" when Run is pressed', () => {
		const { index, nodeIdOf } = setup();
		const session = new RunSession();
		expect(session.status).toBe('idle');

		session.beginStarting(index);
		expect(session.status).toBe('starting');
		expect(session.run.byNode[nodeIdOf('first')].state).toBe('pending');
		expect(FakeEventSource.instances).toHaveLength(0);
	});

	it('streams events into run state and finishes from the full log', async () => {
		const { index, nodeIdOf } = setup();
		const session = new RunSession();
		const started = ev('task.started', 'first');
		const completed = ev('task.completed', 'first', { data: { output: { a: 1 } } });
		routes['/executions/e1/children'] = () => Response.json([]);

		session.start('e1', index, [started]);
		const source = FakeEventSource.latest();
		expect(source.url).toBe(`/executions/e1/watch?afterSeq=${started.seq}`);
		expect(session.status).toBe('running');
		expect(session.run.byNode[nodeIdOf('first')].state).toBe('running');

		source.onopen?.();
		expect(session.connected).toBe(true);

		source.emit('event', completed);
		source.emit('event', completed); // a duplicate is ignored
		source.emit('event', 'not json');
		expect(session.run.byNode[nodeIdOf('first')].state).toBe('success');

		source.emit('status', { status: 'running', error: 'transient' });
		expect(session.error).toBe('transient');
		source.emit('status', '{broken');

		routes['/executions/e1/events'] = () => Response.json({ events: [started, completed] });
		source.emit('done', { status: 'failed', error: 'boom' });
		await flush();

		expect(source.closed).toBe(true);
		expect(session.connected).toBe(false);
		expect(session.status).toBe('failed');
		expect(session.error).toBe('boom');
		expect(session.run.finalized).toBe(true);
		// Never reached: the path not taken.
		expect(session.run.byNode[nodeIdOf('second')].state).toBe('skipped');
		expect(fetchMock).toHaveBeenCalledWith('/executions/e1/events?afterSeq=0');
	});

	it('defaults a done message without a payload to completed', async () => {
		const { index } = setup();
		const session = new RunSession();
		session.start('e1', index);
		FakeEventSource.latest().emit('done', 'garbage');
		await flush();
		expect(session.status).toBe('completed');
	});

	it('replays the whole log in order when an event arrives late', () => {
		const { index, nodeIdOf } = setup();
		const session = new RunSession();
		session.start('e1', index);
		const source = FakeEventSource.latest();

		const start = ev('task.started', 'second');
		const finish = ev('task.completed', 'second');
		// The finish arrives first; its start, with a lower seq, after it.
		source.emit('event', finish);
		source.emit('event', start);
		expect(session.run.byNode[nodeIdOf('second')].state).toBe('success');
		expect(session.run.lastSeq).toBe(finish.seq);
	});

	it('catches up after the server reports it fell behind', async () => {
		const { index, nodeIdOf } = setup();
		const session = new RunSession();
		session.start('e1', index);
		const missed = ev('task.started', 'first');
		routes['/executions/e1/events'] = () => Response.json({ events: [missed] });

		FakeEventSource.latest().emit('refetch', { afterSeq: 0 });
		await flush();
		expect(session.run.byNode[nodeIdOf('first')].state).toBe('running');

		// A failing or unreachable log read leaves the timeline as it is.
		routes['/executions/e1/events'] = () => new Response(null, { status: 500 });
		FakeEventSource.latest().emit('refetch', {});
		fetchMock.mockImplementationOnce(async () => {
			throw new TypeError('offline');
		});
		FakeEventSource.latest().emit('refetch', {});
		await flush();
		expect(session.run.byNode[nodeIdOf('first')].state).toBe('running');
	});

	it('reconnects with backoff, resuming from the last seq', async () => {
		const { index } = setup();
		const session = new RunSession();
		session.start('e1', index);
		const first = FakeEventSource.latest();
		const seen = ev('task.started', 'first');
		first.emit('event', seen);

		first.onerror?.();
		expect(first.closed).toBe(true);
		expect(FakeEventSource.instances).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(FakeEventSource.latest().url).toBe(`/executions/e1/watch?afterSeq=${seen.seq}`);

		// Further failures back off longer, capped at the last delay.
		FakeEventSource.latest().onerror?.();
		await vi.advanceTimersByTimeAsync(999);
		expect(FakeEventSource.instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeEventSource.instances).toHaveLength(3);

		// A successful open resets the backoff.
		FakeEventSource.latest().onopen?.();
		FakeEventSource.latest().onerror?.();
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeEventSource.instances).toHaveLength(4);
	});

	it('does not reconnect once stopped or finished', async () => {
		const { index } = setup();
		const session = new RunSession();
		session.start('e1', index);
		const source = FakeEventSource.latest();
		session.stop();
		source.onerror?.();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(FakeEventSource.instances).toHaveLength(1);

		session.start('e2', index);
		session.status = 'completed';
		FakeEventSource.latest().onerror?.();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(FakeEventSource.instances).toHaveLength(2);
	});

	it('hangs child runs off the node that started them', async () => {
		const { index, nodeIdOf } = setup();
		const child = { id: 'child-1', parentTaskName: 'callChild', parentScopePath: '' } as Execution;
		const orphan = { id: 'child-2' } as Execution;
		routes['/executions/e1/children'] = () => Response.json([child, orphan]);

		const session = new RunSession();
		session.start('e1', index);
		await flush();
		expect(session.childRuns).toEqual([child, orphan]);
		expect(session.run.byNode[nodeIdOf('callChild')].childExecutionId).toBe('child-1');

		// A rebuild after a late event keeps the link.
		const late = ev('task.completed', 'first');
		FakeEventSource.latest().emit('event', ev('task.started', 'second'));
		FakeEventSource.latest().emit('event', { ...late, seq: 0 });
		expect(session.run.byNode[nodeIdOf('callChild')].childExecutionId).toBe('child-1');
	});

	it('tolerates a failing children endpoint', async () => {
		const { index } = setup();
		const session = new RunSession();
		fetchMock.mockImplementationOnce(async () => {
			throw new TypeError('offline');
		});
		session.start('e1', index);
		await flush();
		expect(session.childRuns).toEqual([]);
	});

	it('replays a finished run without opening a stream', () => {
		const { index, nodeIdOf } = setup();
		const session = new RunSession();
		const events = [ev('task.started', 'first'), ev('task.completed', 'first')];
		const child = { id: 'c', parentTaskName: 'callChild' } as Execution;

		session.replay({ id: 'e9', status: 'failed', error: 'nope' } as Execution, index, events, [
			child
		]);

		expect(FakeEventSource.instances).toHaveLength(0);
		expect(session.executionId).toBe('e9');
		expect(session.status).toBe('failed');
		expect(session.error).toBe('nope');
		expect(session.run.byNode[nodeIdOf('first')].state).toBe('success');
		expect(session.run.byNode[nodeIdOf('second')].state).toBe('skipped');
		expect(session.run.byNode[nodeIdOf('callChild')].childExecutionId).toBe('c');
	});

	it('reset forgets the run', () => {
		const { index } = setup();
		const session = new RunSession();
		session.start('e1', index, [ev('task.started', 'first')]);
		session.reset();
		expect(session.executionId).toBeNull();
		expect(session.status).toBe('idle');
		expect(session.childRuns).toEqual([]);
		expect(session.run.lastSeq).toBe(0);
		expect(FakeEventSource.latest().closed).toBe(true);
	});
});
