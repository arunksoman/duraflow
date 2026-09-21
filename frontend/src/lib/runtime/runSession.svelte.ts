import type { Execution, ExecutionEvent, ExecutionStatus } from '$lib/types';
import type { RunIndex } from '$lib/zigflow-engine/runIndex';
import {
	attachChildExecution,
	finalizeRunState,
	initialRunState,
	reduceRunStateAll,
	type RunState
} from '$lib/zigflow-engine/runState';

/**
 * Live view of one workflow run: subscribes to the server's event stream, folds it into
 * `RunState`, and keeps the list of child runs it spawned up to date.
 *
 * Deliberately thin — every decision about what an event means lives in `runState.ts`, which is
 * plain TypeScript with tests. This class only owns the connection and the reactive wrappers, so
 * the builder's live canvas and the execution page's replay can't drift apart.
 */

const EMPTY_INDEX: RunIndex = {
	byScopeAndName: new Map(),
	orderedNodeIdsByScope: new Map(),
	nodeIdsByName: new Map(),
	childScopesByParent: new Map(),
	allNodeIds: [],
	ambiguousScopes: new Set(),
	scopeIdByNodeId: new Map(),
	workflowScopeByName: new Map()
};

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000];

export class RunSession {
	executionId = $state<string | null>(null);
	/** `starting` covers the gap between pressing Run and the server accepting it. */
	status = $state<ExecutionStatus | 'starting' | 'idle'>('idle');
	error = $state<string | null>(null);
	connected = $state(false);
	run = $state<RunState>(initialRunState(EMPTY_INDEX));
	childRuns = $state<Execution[]>([]);

	#index: RunIndex = EMPTY_INDEX;
	/** Every event received for this run, by seq — what the state is rebuilt from when needed. */
	#events = new Map<number, ExecutionEvent>();
	#source: EventSource | null = null;
	#reconnectAttempt = 0;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	/** Forgets the current run entirely — back to "not run yet". The run itself is untouched. */
	reset() {
		this.stop();
		this.#index = EMPTY_INDEX;
		this.executionId = null;
		this.status = 'idle';
		this.error = null;
		this.run = initialRunState(EMPTY_INDEX);
		this.#events = new Map();
		this.childRuns = [];
	}

	/** Resets to "about to run", so the canvas clears the moment the user presses Run. */
	beginStarting(index: RunIndex) {
		this.stop();
		this.#index = index;
		this.#closed = false;
		this.executionId = null;
		this.status = 'starting';
		this.error = null;
		this.run = initialRunState(index);
		this.#events = new Map();
		this.childRuns = [];
	}

	/**
	 * Attaches to an execution. `seedEvents` is for a run that already has recorded history (the
	 * execution detail page loads it server-side); a live run passes none and receives everything
	 * over the stream.
	 */
	start(executionId: string, index: RunIndex, seedEvents: ExecutionEvent[] = []) {
		this.stop();
		this.#index = index;
		this.#closed = false;
		this.#reconnectAttempt = 0;
		this.executionId = executionId;
		this.error = null;
		this.status = 'running';
		this.#events = new Map();
		this.run = initialRunState(index);
		this.#apply(seedEvents);
		this.childRuns = [];

		void this.#refreshChildren();
		this.#connect();
	}

	/** Renders a finished run from stored events, without opening a stream. */
	replay(execution: Execution, index: RunIndex, events: ExecutionEvent[], children: Execution[]) {
		this.stop();
		this.#index = index;
		this.executionId = execution.id;
		this.error = execution.error ?? null;
		this.childRuns = children;
		this.#events = new Map(events.map((e) => [e.seq, e]));
		this.run = finalizeRunState(this.#rebuild(), execution.status);
		this.#attachChildren(children);
		this.status = execution.status;
	}

	stop() {
		this.#closed = true;
		clearTimeout(this.#reconnectTimer);
		this.#source?.close();
		this.#source = null;
		this.connected = false;
	}

	#connect() {
		if (this.#closed || !this.executionId) return;

		const source = new EventSource(
			`/executions/${this.executionId}/watch?afterSeq=${this.run.lastSeq}`
		);
		this.#source = source;

		source.onopen = () => {
			this.connected = true;
			this.#reconnectAttempt = 0;
		};

		source.addEventListener('event', (e) => {
			const event = parseEvent<ExecutionEvent>(e);
			if (event) this.#apply([event]);
		});

		source.addEventListener('status', (e) => {
			const payload = parseEvent<{ status: ExecutionStatus; error?: string }>(e);
			if (!payload) return;
			this.status = payload.status;
			if (payload.error) this.error = payload.error;
		});

		// The server fell behind buffering for us; re-read what we missed rather than carry on
		// with a hole in the timeline.
		source.addEventListener('refetch', () => void this.#catchUp());

		source.addEventListener('done', (e) => {
			const payload = parseEvent<{ status: ExecutionStatus; error?: string }>(e);
			const status = payload?.status ?? 'completed';
			void this.#finish(status, payload?.error);
		});

		source.onerror = () => {
			this.connected = false;
			source.close();
			if (this.#closed || this.status !== 'running') return;
			this.#scheduleReconnect();
		};
	}

	#scheduleReconnect() {
		const delay =
			RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
		this.#reconnectAttempt++;
		// Reconnecting resumes from `lastSeq`, and the server replays the backlog from there, so a
		// dropped connection costs latency but never events.
		this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
	}

	async #finish(status: ExecutionStatus, error?: string) {
		this.stop();
		// The whole log, not just what's after `lastSeq`: an event resolved late can carry a lower
		// seq than one already shown, and the finished run should reflect all of them.
		await this.#catchUp(0);
		await this.#refreshChildren();
		this.status = status;
		if (error) this.error = error;
		this.run = finalizeRunState(this.run, status);
	}

	async #catchUp(afterSeq = this.run.lastSeq) {
		if (!this.executionId) return;
		try {
			const response = await fetch(`/executions/${this.executionId}/events?afterSeq=${afterSeq}`);
			if (!response.ok) return;
			const body = (await response.json()) as { events: ExecutionEvent[] };
			if (body.events?.length) this.#apply(body.events);
		} catch {
			// Offline or the run was deleted; the timeline we already have still stands.
		}
	}

	async #refreshChildren() {
		if (!this.executionId) return;
		try {
			const response = await fetch(`/executions/${this.executionId}/children`);
			if (!response.ok) return;
			const children = (await response.json()) as Execution[];
			this.childRuns = children;
			this.#attachChildren(children);
		} catch {
			// Child links are an enhancement; the run itself is unaffected.
		}
	}

	/**
	 * Folds in newly received events. Events normally arrive in seq order and are applied
	 * incrementally, but the server can deliver one late (a task's start resolved after its
	 * finish); the reducer ignores anything at or below the seq it has reached, so a late event
	 * triggers a replay of the whole log in order instead of being lost.
	 */
	#apply(events: ExecutionEvent[]) {
		const fresh = events.filter((e) => !this.#events.has(e.seq));
		if (fresh.length === 0) return;
		for (const event of fresh) this.#events.set(event.seq, event);

		const outOfOrder = fresh.some((e) => e.seq <= this.run.lastSeq);
		if (!outOfOrder) {
			this.run = reduceRunStateAll(
				this.run,
				[...fresh].sort((a, b) => a.seq - b.seq),
				this.#index
			);
			return;
		}
		const childRuns = this.childRuns;
		this.run = this.#rebuild();
		this.#attachChildren(childRuns);
	}

	#rebuild(): RunState {
		const ordered = [...this.#events.values()].sort((a, b) => a.seq - b.seq);
		return reduceRunStateAll(initialRunState(this.#index), ordered, this.#index);
	}

	/** Hangs each discovered child run off the `childWorkflow` node that started it. */
	#attachChildren(children: Execution[]) {
		let next = this.run;
		for (const child of children) {
			if (!child.parentTaskName) continue;
			next = attachChildExecution(
				next,
				this.#index,
				child.parentTaskName,
				child.parentScopePath ?? '',
				child.id
			);
		}
		this.run = next;
	}
}

function parseEvent<T>(e: Event): T | null {
	try {
		return JSON.parse((e as MessageEvent).data) as T;
	} catch {
		return null;
	}
}
