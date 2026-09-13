<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { AlertTriangle, ArrowLeft, RefreshCw, Trash2 } from '@lucide/svelte';

	import RunWorkspace from '$lib/components/execution/RunWorkspace.svelte';
	import DeleteRunsDialog from '$lib/components/execution/DeleteRunsDialog.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { astToGraph, type ScopeGraph } from '$lib/zigflow-engine/graph';
	import { deserializeZigflowDocument } from '$lib/zigflow-engine/deserialize';
	import { buildRunIndex } from '$lib/zigflow-engine/runIndex';
	import { RunSession } from '$lib/runtime/runSession.svelte';
	import type { ExecutionStatus } from '$lib/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let showDelete = $state(false);

	const statusClass: Record<ExecutionStatus, string> = {
		running: 'badge-info',
		completed: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-warning',
		terminated: 'badge-warning',
		timed_out: 'badge-error'
	};

	// The canvas is rebuilt from the workflow's stored DSL, which is the same source the builder
	// draws from — so the highlighted graph matches what the designer authored.
	const parsed = untrack(() => {
		if (!data.workflow?.dsl) return null;
		const result = deserializeZigflowDocument(data.workflow.dsl);
		if (!result.ok) return null;
		return astToGraph(result.document);
	});

	const scopes: Record<string, ScopeGraph> = parsed?.graph.scopes ?? {};
	const runIndex = buildRunIndex({ scopes });

	const session = new RunSession();

	// A finished run renders from the events the server already sent; a still-running one attaches
	// to the live stream and keeps going from where those events left off.
	untrack(() => {
		if (data.execution.status === 'running') {
			session.start(data.execution.id, runIndex, data.events);
			session.childRuns = data.children;
		} else {
			session.replay(data.execution, runIndex, data.events, data.children);
		}
	});

	$effect(() => {
		return () => session.stop();
	});

	const durationLabel = $derived.by(() => {
		const { startedAt, completedAt } = data.execution;
		if (!completedAt) return '';
		const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
	});

	const workflowLabel = $derived(
		data.execution.workflowName || data.execution.workflowType || 'Unknown workflow'
	);
</script>

<svelte:head>
	<title>{workflowLabel} run · DuraFlow</title>
</svelte:head>

<div class="flex h-[calc(100vh-2rem)] flex-col gap-3">
	<!-- Header -->
	<div class="flex flex-wrap items-center gap-3">
		<a class="btn btn-ghost btn-sm gap-1.5" href="/executions">
			<ArrowLeft size={14} />
			Executions
		</a>

		{#if data.parent}
			<span class="text-base-content/40">/</span>
			<a class="link link-hover text-sm" href="/executions/{data.parent.id}">
				{data.parent.workflowName || 'parent run'}
				{#if data.execution.parentTaskName}
					<span class="text-base-content/50">· {data.execution.parentTaskName}</span>
				{/if}
			</a>
		{/if}

		<span class="text-base-content/40">/</span>
		<h1 class="text-lg font-semibold">{workflowLabel}</h1>
		<code class="text-base-content/50 text-xs">{data.execution.id.slice(0, 8)}</code>

		<span class="badge {statusClass[data.execution.status]} badge-sm">
			{session.status === 'running' ? 'running' : data.execution.status}
		</span>
		<span class="badge badge-outline badge-sm" title="What started this run">
			{data.execution.trigger ?? 'manual'}
		</span>

		<span class="text-base-content/50 text-xs">
			{new Date(data.execution.startedAt).toLocaleString()}
			{#if durationLabel}· {durationLabel}{/if}
		</span>

		<div class="ml-auto flex items-center gap-2">
			{#if data.execution.workflowId}
				<a
					class="btn btn-ghost btn-sm"
					href="/projects/{data.workflow?.projectId}/workflows/{data.execution.workflowId}/builder"
				>
					Open in builder
				</a>
				<form method="POST" action="?/rerun" use:enhance>
					<button class="btn btn-sm gap-1.5" type="submit">
						<RefreshCw size={14} />
						Re-run
					</button>
				</form>
			{/if}
			{#if !data.execution.parentExecutionId}
				<button
					class="btn btn-ghost btn-sm text-error gap-1.5"
					type="button"
					onclick={() => (showDelete = true)}
				>
					<Trash2 size={14} />
					Delete
				</button>
			{/if}
			<ThemeToggle />
		</div>
	</div>

	{#if data.execution.error}
		<div class="alert alert-error gap-2 py-2 text-sm">
			<AlertTriangle size={16} />
			<span class="whitespace-pre-wrap">{data.execution.error}</span>
		</div>
	{/if}

	<div class="border-base-300 min-h-0 flex-1 overflow-hidden rounded-lg border">
		<RunWorkspace {session} index={runIndex} {scopes} />
	</div>
</div>

{#if showDelete}
	<DeleteRunsDialog
		action="?/delete"
		ids={[data.execution.id]}
		running={data.execution.status === 'running' ? 1 : 0}
		error={form && 'deleteError' in form ? form.deleteError : undefined}
		onclose={() => (showDelete = false)}
	/>
{/if}
