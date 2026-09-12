<script lang="ts">
	import type { Node } from '@xyflow/svelte';
	import { AlertTriangle, ExternalLink, TriangleAlert } from '@lucide/svelte';
	import type { ExecutionStatus } from '$lib/types';
	import type { RunSession } from '$lib/runtime/runSession.svelte';
	import type { RunIndex } from '$lib/zigflow-engine/runIndex';
	import type { NodeRunState, RunLogEntry } from '$lib/zigflow-engine/runState';

	/**
	 * Everything a run produced, in one panel: the ordered log, the selected node's input/output,
	 * the child runs it started. Shared verbatim between the builder (live) and the execution
	 * detail page (replayed), so both show the same thing.
	 */

	interface Props {
		session: RunSession;
		index: RunIndex;
		nodes: Node[];
		selectedNodeId?: string | null;
		onselectnode?: (nodeId: string) => void;
		/** Link to the standalone page for this run; omitted when already on it. */
		fullRunHref?: string;
	}

	let { session, index, nodes, selectedNodeId = null, onselectnode, fullRunHref }: Props = $props();

	type Tab = 'log' | 'task' | 'children' | 'output';
	let tab = $state<Tab>('log');

	const labelByNodeId = $derived(
		new Map(nodes.map((n) => [n.id, ((n.data?.label as string) || n.type) ?? n.id]))
	);

	const selectedDetail = $derived(selectedNodeId ? session.run.byNode[selectedNodeId] : undefined);
	const selectedLabel = $derived(
		selectedNodeId ? (labelByNodeId.get(selectedNodeId) ?? selectedNodeId) : ''
	);

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

	const nodeStateClass: Record<NodeRunState, string> = {
		pending: 'text-base-content/40',
		running: 'text-info',
		success: 'text-success',
		error: 'text-error',
		skipped: 'text-base-content/40',
		unknown: 'text-warning'
	};

	// A run reaches "every node accounted for" only once it has finished; before that, silence on a
	// node means "not yet", which is why the counts are only worth showing at the end.
	const counts = $derived(
		Object.values(session.run.byNode).reduce(
			(acc, detail) => {
				acc[detail.state] = (acc[detail.state] ?? 0) + 1;
				return acc;
			},
			{} as Record<NodeRunState, number>
		)
	);

	function selectEntry(entry: RunLogEntry) {
		if (!entry.nodeId) return;
		onselectnode?.(entry.nodeId);
		tab = 'task';
	}

	function pretty(value: unknown): string {
		if (value === undefined) return '—';
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	function eventTypeClass(eventType: string): string {
		if (eventType === 'task.faulted' || eventType === 'task.cancelled') return 'text-error';
		if (eventType === 'task.completed' || eventType === 'workflow.completed') return 'text-success';
		if (eventType === 'task.retried') return 'text-warning';
		return 'text-base-content/60';
	}

	function time(iso: string): string {
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
	}

	function duration(startedAt?: string, endedAt?: string): string {
		if (!startedAt || !endedAt) return '';
		const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
	}
</script>

<div class="border-base-300 bg-base-100 flex h-full min-h-0 flex-col border-t">
	<!-- Header strip -->
	<div class="border-base-300 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
		<span class="badge {statusClass[session.status]} badge-sm">{session.status}</span>

		{#if session.connected}
			<span class="text-base-content/50">live</span>
		{/if}

		{#if session.run.finalized}
			<span class="text-base-content/60">
				{counts.success ?? 0} ran · {counts.error ?? 0} failed · {counts.skipped ?? 0} not on path
			</span>
		{/if}

		{#if session.error}
			<span class="text-error truncate" title={session.error}>{session.error}</span>
		{/if}

		<div class="ml-auto flex items-center gap-2">
			{#if fullRunHref && session.executionId}
				<a class="link link-hover inline-flex items-center gap-1" href={fullRunHref}>
					Open full run <ExternalLink size={12} />
				</a>
			{/if}
		</div>
	</div>

	<!-- Correlation warnings: better to say the mapping is uncertain than to colour a wrong node -->
	{#if session.run.unmatched.length > 0 || index.ambiguousScopes.size > 0}
		<div class="alert alert-warning mx-3 mt-2 gap-2 py-2 text-xs">
			<TriangleAlert size={14} />
			<span>
				{#if session.run.unmatched.length > 0}
					{session.run.unmatched.length} event(s) couldn't be matched to a node ({[
						...new Set(session.run.unmatched.map((u) => u.taskName))
					]
						.slice(0, 4)
						.join(', ')}).
				{/if}
				{#if index.ambiguousScopes.size > 0}
					Some scopes contain two sibling loops or try blocks, which zigflow reports
					indistinguishably — highlighting inside them may be approximate.
				{/if}
			</span>
		</div>
	{/if}

	<div role="tablist" class="tabs tabs-border px-2 pt-1 text-xs">
		<button
			role="tab"
			class="tab"
			class:tab-active={tab === 'log'}
			onclick={() => (tab = 'log')}>Log ({session.run.log.length})</button
		>
		<button role="tab" class="tab" class:tab-active={tab === 'task'} onclick={() => (tab = 'task')}>
			Task details
		</button>
		<button
			role="tab"
			class="tab"
			class:tab-active={tab === 'children'}
			onclick={() => (tab = 'children')}>Child runs ({session.childRuns.length})</button
		>
		<button
			role="tab"
			class="tab"
			class:tab-active={tab === 'output'}
			onclick={() => (tab = 'output')}>Input / output</button
		>
	</div>

	<div class="min-h-0 flex-1 overflow-auto px-3 py-2 text-xs">
		{#if tab === 'log'}
			{#if session.run.log.length === 0}
				<p class="text-base-content/50 py-6 text-center">
					No task events yet. They appear here as each task starts and finishes.
				</p>
			{:else}
				<table class="table-xs table">
					<tbody>
						{#each session.run.log as entry (entry.seq)}
							<tr
								class="hover:bg-base-200 cursor-pointer"
								class:opacity-60={!entry.nodeId}
								onclick={() => selectEntry(entry)}
							>
								<td class="text-base-content/50 w-20 whitespace-nowrap">{time(entry.occurredAt)}</td>
								<td class="text-base-content/50 w-40 truncate" title={entry.scopeLabel}>
									{entry.scopeLabel}
								</td>
								<td class="font-medium">
									{entry.nodeId ? (labelByNodeId.get(entry.nodeId) ?? entry.taskName) : entry.taskName}
									{#if entry.confidence === 'name-only'}
										<span class="text-warning" title="Matched by task name only">~</span>
									{/if}
								</td>
								<td class="w-32">
									<span class={eventTypeClass(entry.eventType)}>{entry.eventType}</span>
									{#if entry.attempt && entry.attempt > 1}
										<span class="badge badge-ghost badge-xs">attempt {entry.attempt}</span>
									{/if}
								</td>
								<td class="text-error max-w-64 truncate" title={entry.error ?? ''}>
									{entry.error ?? ''}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{:else if tab === 'task'}
			{#if !selectedNodeId || !selectedDetail}
				<p class="text-base-content/50 py-6 text-center">
					Select a node on the canvas, or a row in the log, to see what it received and returned.
				</p>
			{:else}
				<div class="flex flex-wrap items-center gap-3 pb-2">
					<span class="font-medium">{selectedLabel}</span>
					<span class={nodeStateClass[selectedDetail.state]}>{selectedDetail.state}</span>
					{#if selectedDetail.attempts > 1}
						<span class="badge badge-ghost badge-xs">{selectedDetail.attempts} attempts</span>
					{/if}
					{#if duration(selectedDetail.startedAt, selectedDetail.endedAt)}
						<span class="text-base-content/50"
							>{duration(selectedDetail.startedAt, selectedDetail.endedAt)}</span
						>
					{/if}
					{#if selectedDetail.childExecutionId}
						<a
							class="link link-hover inline-flex items-center gap-1"
							href="/executions/{selectedDetail.childExecutionId}"
						>
							Open child run <ExternalLink size={12} />
						</a>
					{/if}
				</div>

				{#if selectedDetail.error}
					<div class="alert alert-error mb-2 gap-2 py-2">
						<AlertTriangle size={14} />
						<span class="whitespace-pre-wrap">{selectedDetail.error}</span>
					</div>
				{/if}

				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div>
						<p class="text-base-content/40 mb-1 font-semibold uppercase">Input</p>
						<pre class="bg-base-200 overflow-x-auto rounded p-2">{pretty(selectedDetail.input)}</pre>
					</div>
					<div>
						<p class="text-base-content/40 mb-1 font-semibold uppercase">Output</p>
						<pre class="bg-base-200 overflow-x-auto rounded p-2">{pretty(selectedDetail.output)}</pre>
					</div>
				</div>

				{#if selectedDetail.taskState !== undefined}
					<details class="mt-3">
						<summary class="cursor-pointer font-semibold uppercase opacity-40">
							Workflow state at this task
						</summary>
						<pre class="bg-base-200 mt-1 overflow-x-auto rounded p-2">{pretty(
								selectedDetail.taskState
							)}</pre>
					</details>
				{/if}
			{/if}
		{:else if tab === 'children'}
			{#if session.childRuns.length === 0}
				<p class="text-base-content/50 py-6 text-center">
					This run started no child workflows.
				</p>
			{:else}
				<table class="table-xs table">
					<thead>
						<tr><th>Started by</th><th>Workflow</th><th>Status</th><th></th></tr>
					</thead>
					<tbody>
						{#each session.childRuns as child (child.id)}
							<tr>
								<td>{child.parentTaskName || '—'}</td>
								<td>{child.workflowName || child.workflowType || child.id.slice(0, 8)}</td>
								<td><span class="badge {statusClass[child.status]} badge-xs">{child.status}</span></td>
								<td>
									<a class="link link-hover" href="/executions/{child.id}">Open →</a>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{:else}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div>
					<p class="text-base-content/40 mb-1 font-semibold uppercase">Workflow input</p>
					<pre class="bg-base-200 overflow-x-auto rounded p-2">{pretty(
							session.run.workflowInput
						)}</pre>
				</div>
				<div>
					<p class="text-base-content/40 mb-1 font-semibold uppercase">Workflow output</p>
					<pre class="bg-base-200 overflow-x-auto rounded p-2">{pretty(
							session.run.workflowOutput
						)}</pre>
				</div>
			</div>
		{/if}
	</div>
</div>
