<script lang="ts">
	import { untrack } from 'svelte';
	import { ExternalLink, ListChecks, Play, RotateCcw, X } from '@lucide/svelte';
	import RunWorkspace from './RunWorkspace.svelte';
	import WorkflowInputForm from './WorkflowInputForm.svelte';
	import type { RunSession } from '$lib/runtime/runSession.svelte';
	import type { RunIndex } from '$lib/zigflow-engine/runIndex';
	import type { ScopeGraph } from '$lib/zigflow-engine/graph';
	import type { ExecutionStatus, InputField } from '$lib/types';

	/**
	 * The builder's run window. A run happens inside it and stays inspectable after it ends; closing
	 * it only hides it (a run in progress keeps going), and running again reuses the same window,
	 * clearing the previous run's highlighting and data first.
	 */

	interface Props {
		workflowName: string;
		session: RunSession;
		index: RunIndex;
		scopes: Record<string, ScopeGraph>;
		fields: InputField[];
		input: Record<string, unknown>;
		inputErrors: Record<string, string>;
		inputJsonError: string | null;
		runError: string | null;
		/** True once the design has moved on from the DSL this run executed. */
		canvasChanged: boolean;
		allRunsHref: string;
		onjsonerror: (message: string | null) => void;
		onrun: () => void;
		onclose: () => void;
	}

	let {
		workflowName,
		session,
		index,
		scopes,
		fields,
		input = $bindable(),
		inputErrors,
		inputJsonError,
		runError,
		canvasChanged,
		allRunsHref,
		onjsonerror,
		onrun,
		onclose
	}: Props = $props();

	const busy = $derived(session.status === 'starting' || session.status === 'running');
	const hasRun = $derived(session.status !== 'idle');

	const statusClass: Record<ExecutionStatus | 'starting' | 'idle', string> = {
		idle: 'badge-ghost',
		starting: 'badge-info',
		running: 'badge-info',
		completed: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-warning',
		terminated: 'badge-warning',
		timed_out: 'badge-error'
	};

	// Inputs start open when there's something to fill in before the first run; after that they
	// fold away so the run gets the room, one click from being edited for the next run.
	let inputsOpen = $state(false);
	$effect.pre(() => {
		if ((!hasRun && fields.length > 0) || Object.keys(inputErrors).length > 0) inputsOpen = true;
	});

	let startedAtMs = $state<number | null>(null);
	let endedAtMs = $state<number | null>(null);
	let now = $state(Date.now());

	// Wall-clock time as seen from here — tracks only the status, since it writes the timestamps it
	// would otherwise also be reading.
	$effect(() => {
		const status = session.status;
		untrack(() => {
			if (status === 'starting') {
				startedAtMs = Date.now();
				endedAtMs = null;
			} else if (status !== 'running' && startedAtMs !== null && endedAtMs === null) {
				endedAtMs = Date.now();
			}
		});
	});

	$effect(() => {
		if (!busy) return;
		const timer = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(timer);
	});

	const elapsed = $derived.by(() => {
		if (startedAtMs === null) return '';
		const ms = (endedAtMs ?? now) - startedAtMs;
		return ms < 1000 ? `${Math.max(ms, 0)} ms` : `${(ms / 1000).toFixed(1)} s`;
	});

	function run() {
		onrun();
		if (Object.keys(inputErrors).length === 0 && !inputJsonError) inputsOpen = false;
	}
</script>

<div class="modal modal-open z-50" role="dialog" aria-modal="true" aria-label="Run {workflowName}">
	<div class="modal-box flex h-[94vh] w-[97vw] max-w-none flex-col overflow-hidden p-0">
		<header class="border-base-300 flex shrink-0 items-center gap-3 border-b px-4 py-2">
			<div class="min-w-0">
				<h2 class="truncate text-sm font-semibold">Run · {workflowName}</h2>
				<p class="text-base-content/50 text-[11px]">Manual test run of the design on screen</p>
			</div>
			<span class="badge badge-sm {statusClass[session.status]}">
				{session.status === 'idle' ? 'not run yet' : session.status}
			</span>
			{#if elapsed}
				<span class="text-base-content/50 text-xs tabular-nums">{elapsed}</span>
			{/if}
			{#if runError}
				<span class="text-error max-w-96 truncate text-xs" title={runError}>{runError}</span>
			{/if}

			<div class="ml-auto flex items-center gap-1">
				{#if session.executionId}
					<a
						class="btn btn-ghost btn-sm gap-1.5"
						href="/executions/{session.executionId}"
						target="_blank"
						rel="noopener"
						title="Open this run on its own page"
					>
						<ExternalLink size={14} />
						Run page
					</a>
				{/if}
				<a
					class="btn btn-ghost btn-sm gap-1.5"
					href={allRunsHref}
					target="_blank"
					rel="noopener"
					title="Every run of this workflow"
				>
					<ListChecks size={14} />
					All runs
				</a>
				<button
					type="button"
					class="btn btn-primary btn-sm gap-1.5"
					disabled={busy || !!inputJsonError}
					onclick={run}
					title="Save the design and run it with the inputs on the left"
				>
					{#if hasRun}<RotateCcw size={14} />{:else}<Play size={14} />{/if}
					{busy ? 'Running…' : hasRun ? 'Run again' : 'Run'}
				</button>
				<button
					type="button"
					class="btn btn-ghost btn-sm btn-square"
					onclick={onclose}
					title="Close — a run in progress keeps going"
					aria-label="Close run window"
				>
					<X size={16} />
				</button>
			</div>
		</header>

		<div class="min-h-0 flex-1">
			<RunWorkspace {session} {index} {scopes}>
				{#snippet sidebarTop()}
					<details class="border-base-300 border-b" bind:open={inputsOpen}>
						<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-semibold">
							Inputs
							<span class="text-base-content/50 text-xs font-normal">
								{fields.length > 0 ? `${fields.length} declared` : '$input as JSON'}
							</span>
							{#if Object.keys(inputErrors).length > 0 || inputJsonError}
								<span class="badge badge-error badge-xs">fix</span>
							{/if}
						</summary>
						<div class="max-h-[45vh] overflow-auto px-3 pb-3">
							<WorkflowInputForm {fields} bind:value={input} errors={inputErrors} {onjsonerror} />
						</div>
					</details>
				{/snippet}
				{#snippet canvasBanner()}
					{#if canvasChanged}
						<div
							class="alert alert-warning absolute top-2 left-1/2 z-10 w-auto -translate-x-1/2 py-1.5 text-xs shadow"
						>
							<span
								>The design changed since this run started — this shows what was run. Run again to
								test the changes.</span
							>
						</div>
					{/if}
				{/snippet}
			</RunWorkspace>
		</div>
	</div>
</div>
