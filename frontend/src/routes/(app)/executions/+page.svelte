<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import { ChevronLeft, ChevronRight, ListChecks, Play, Trash2, X } from '@lucide/svelte';
	import WorkflowInputForm from '$lib/components/execution/WorkflowInputForm.svelte';
	import DeleteRunsDialog from '$lib/components/execution/DeleteRunsDialog.svelte';
	import { coerceInput, validateInput } from '$lib/zigflow-engine/inputSchema';
	import type { PageProps } from './$types';
	import type { Execution, ExecutionStatus, ExecutionTrigger } from '$lib/types';

	let { data, form }: PageProps = $props();

	let dialogEl: HTMLDialogElement | undefined;
	let running = $state(false);

	// The input form is built from the selected workflow's declared fields, so the dialog can't
	// render it until one is chosen.
	let selectedWorkflowId = $state('');
	let runInput = $state<Record<string, unknown>>({});
	let runInputErrors = $state<Record<string, string>>({});
	let runInputJsonError = $state<string | null>(null);

	const selectedWorkflow = $derived(data.workflows.find((w) => w.id === selectedWorkflowId));
	const inputFields = $derived(selectedWorkflow?.inputSchema ?? []);

	function selectWorkflow(id: string) {
		selectedWorkflowId = id;
		runInput = {};
		runInputErrors = {};
		runInputJsonError = null;
	}

	function dialogRef(node: HTMLDialogElement) {
		dialogEl = node;
	}

	const statusClass: Record<ExecutionStatus, string> = {
		running: 'badge-info',
		completed: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-warning',
		terminated: 'badge-warning',
		timed_out: 'badge-error'
	};

	const triggerClass: Record<ExecutionTrigger, string> = {
		manual: 'badge-ghost',
		scheduled: 'badge-primary badge-outline',
		backfill: 'badge-secondary badge-outline'
	};

	const statuses: ExecutionStatus[] = [
		'running',
		'completed',
		'failed',
		'cancelled',
		'terminated',
		'timed_out'
	];

	// ── Filters (in the URL) ─────────────────────────────────────────

	let filterForm: HTMLFormElement | undefined = $state();
	const hasFilters = $derived(
		Boolean(
			data.filters.workflowId ||
			data.filters.trigger ||
			data.filters.status ||
			data.filters.from ||
			data.filters.to
		)
	);

	const pageCount = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));

	function pageHref(target: number): string {
		const params = new SvelteURLSearchParams(page.url.searchParams);
		if (target <= 1) params.delete('page');
		else params.set('page', String(target));
		const query = params.toString();
		return query ? `?${query}` : '?';
	}

	// ── Selection & delete ───────────────────────────────────────────

	const selected = new SvelteSet<string>();
	let deleteIds = $state<string[] | null>(null);

	// Rows can disappear under the selection (a delete, a filter change): only count what's shown.
	const visibleSelected = $derived(data.executions.filter((e) => selected.has(e.id)));
	const allSelected = $derived(
		data.executions.length > 0 && visibleSelected.length === data.executions.length
	);

	function toggleAll() {
		if (allSelected) selected.clear();
		else for (const e of data.executions) selected.add(e.id);
	}

	function toggle(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	const deleteRunning = $derived(
		deleteIds
			? data.executions.filter((e) => deleteIds!.includes(e.id) && e.status === 'running').length
			: 0
	);

	function duration(execution: Execution): string {
		if (!execution.completedAt) return execution.status === 'running' ? '…' : '';
		const ms = new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		if (ms < 1000) return `${ms} ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	}
</script>

<svelte:head>
	<title>Executions · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-xl font-semibold">Executions</h1>
			<p class="text-base-content/60 mt-1 text-sm">
				Workflow runs across all projects, newest first.
			</p>
		</div>
		<button
			class="btn btn-primary"
			disabled={data.workflows.length === 0}
			onclick={() => dialogEl?.showModal()}
		>
			<Play size={16} />
			Run Workflow
		</button>
	</div>

	<!-- Filters: a plain GET form, so the URL is the source of truth -->
	<form
		method="GET"
		bind:this={filterForm}
		class="border-base-300 bg-base-100 flex flex-wrap items-end gap-3 rounded-lg border p-3"
		onchange={() => filterForm?.requestSubmit()}
	>
		<label class="flex flex-col gap-1">
			<span class="text-base-content/60 text-xs">Workflow</span>
			<select name="workflowId" class="select select-sm w-56" value={data.filters.workflowId}>
				<option value="">All workflows</option>
				{#each data.workflows as workflow (workflow.id)}
					<option value={workflow.id}>{workflow.projectName} / {workflow.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-base-content/60 text-xs">Run type</span>
			<select name="trigger" class="select select-sm w-36" value={data.filters.trigger}>
				<option value="">All types</option>
				<option value="manual">Manual</option>
				<option value="scheduled">Scheduled</option>
				<option value="backfill">Backfill</option>
			</select>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-base-content/60 text-xs">Status</span>
			<select name="status" class="select select-sm w-36" value={data.filters.status}>
				<option value="">Any status</option>
				{#each statuses as status (status)}
					<option value={status}>{status.replace('_', ' ')}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-base-content/60 text-xs">Started from (UTC)</span>
			<input type="date" name="from" class="input input-sm w-40" value={data.filters.from} />
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-base-content/60 text-xs">to</span>
			<input type="date" name="to" class="input input-sm w-40" value={data.filters.to} />
		</label>
		{#if hasFilters}
			<a class="btn btn-ghost btn-sm gap-1" href="/executions">
				<X size={14} />
				Clear
			</a>
		{/if}
		<noscript><button class="btn btn-sm" type="submit">Apply</button></noscript>
	</form>

	{#if data.apiError}
		<div class="alert alert-warning text-sm"><span>Couldn't reach the executions API.</span></div>
	{/if}

	{#if form && 'deleted' in form && form.deleted}
		<div class="alert alert-success py-2 text-sm">
			<span>Deleted {form.deleted} {form.deleted === 1 ? 'run' : 'runs'}.</span>
		</div>
	{/if}

	{#if data.executions.length === 0}
		<div class="text-base-content/50 flex flex-col items-center gap-2 py-20">
			<ListChecks size={40} />
			<p>{hasFilters ? 'No runs match these filters.' : 'No executions yet.'}</p>
		</div>
	{:else}
		<div class="flex min-h-8 items-center gap-3 text-sm">
			<span class="text-base-content/60">
				{data.total}
				{data.total === 1 ? 'run' : 'runs'}
			</span>
			{#if visibleSelected.length > 0}
				<span class="text-base-content/60">· {visibleSelected.length} selected</span>
				<button
					type="button"
					class="btn btn-error btn-sm btn-outline gap-1.5"
					onclick={() => (deleteIds = visibleSelected.map((e) => e.id))}
				>
					<Trash2 size={14} />
					Delete selected
				</button>
			{/if}
		</div>

		<div class="border-base-300 bg-base-100 overflow-x-auto rounded-lg border">
			<table class="table-sm table">
				<thead>
					<tr>
						<th class="w-8">
							<input
								type="checkbox"
								class="checkbox checkbox-xs"
								checked={allSelected}
								indeterminate={visibleSelected.length > 0 && !allSelected}
								onchange={toggleAll}
								aria-label="Select all runs on this page"
							/>
						</th>
						<th>Status</th>
						<th>Type</th>
						<th>Workflow</th>
						<th>Started</th>
						<th>Duration</th>
						<th>Error</th>
						<th class="w-10"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.executions as execution (execution.id)}
						<tr class="hover:bg-base-200/60">
							<td>
								<input
									type="checkbox"
									class="checkbox checkbox-xs"
									checked={selected.has(execution.id)}
									onchange={() => toggle(execution.id)}
									aria-label="Select run {execution.id.slice(0, 8)}"
								/>
							</td>
							<td>
								<span class="badge badge-sm {statusClass[execution.status]}"
									>{execution.status}</span
								>
							</td>
							<td>
								<span class="badge badge-sm {triggerClass[execution.trigger ?? 'manual']}">
									{execution.trigger ?? 'manual'}
								</span>
							</td>
							<td>
								<a class="link link-hover font-medium" href="/executions/{execution.id}">
									{execution.workflowName || execution.workflowType || 'Unknown workflow'}
								</a>
								{#if execution.projectName}
									<span class="text-base-content/50 block text-xs">{execution.projectName}</span>
								{/if}
							</td>
							<td class="text-base-content/70 text-xs whitespace-nowrap">
								{new Date(execution.startedAt).toLocaleString()}
							</td>
							<td class="text-base-content/70 text-xs whitespace-nowrap">{duration(execution)}</td>
							<td class="max-w-64">
								{#if execution.error}
									<span class="text-error block truncate text-xs" title={execution.error}>
										{execution.error}
									</span>
								{/if}
							</td>
							<td>
								<button
									type="button"
									class="btn btn-ghost btn-xs btn-square text-error"
									onclick={() => (deleteIds = [execution.id])}
									aria-label="Delete run {execution.id.slice(0, 8)}"
									title="Delete run"
								>
									<Trash2 size={14} />
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if pageCount > 1}
			<div class="flex items-center justify-end gap-2 text-sm">
				<span class="text-base-content/60">Page {data.filters.page} of {pageCount}</span>
				<div class="join">
					<a
						class="btn btn-sm join-item"
						class:btn-disabled={data.filters.page <= 1}
						href={pageHref(data.filters.page - 1)}
						aria-label="Previous page"
					>
						<ChevronLeft size={14} />
					</a>
					<a
						class="btn btn-sm join-item"
						class:btn-disabled={data.filters.page >= pageCount}
						href={pageHref(data.filters.page + 1)}
						aria-label="Next page"
					>
						<ChevronRight size={14} />
					</a>
				</div>
			</div>
		{/if}
	{/if}
</div>

{#if deleteIds}
	<DeleteRunsDialog
		action="?/delete"
		ids={deleteIds}
		running={deleteRunning}
		error={form && 'deleteError' in form ? form.deleteError : undefined}
		onclose={() => (deleteIds = null)}
		ondone={() => {
			for (const id of deleteIds ?? []) selected.delete(id);
			deleteIds = null;
		}}
	/>
{/if}

<dialog {@attach dialogRef} class="modal">
	<div class="modal-box">
		<h3 class="text-lg font-semibold">Run a workflow</h3>

		<form
			method="POST"
			action="?/run"
			class="mt-4 flex flex-col gap-3"
			use:enhance={({ formData, cancel }) => {
				const coerced = coerceInput(inputFields, runInput);
				runInputErrors = validateInput(inputFields, coerced);
				if (Object.keys(runInputErrors).length > 0 || runInputJsonError) {
					cancel();
					return;
				}
				formData.set('input', JSON.stringify(coerced));

				running = true;
				return async ({ result, update }) => {
					running = false;
					if (result.type === 'success') dialogEl?.close();
					await update();
				};
			}}
		>
			{#if form && 'error' in form && form.error}
				<div class="alert alert-error py-2 text-sm"><span>{form.error}</span></div>
			{/if}

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Workflow</span>
				<select
					name="workflowId"
					class="select w-full"
					required
					value={selectedWorkflowId}
					onchange={(e) => selectWorkflow(e.currentTarget.value)}
				>
					<option value="" disabled>Choose a workflow…</option>
					{#each data.workflows as workflow (workflow.id)}
						<option value={workflow.id}>{workflow.projectName} / {workflow.name}</option>
					{/each}
				</select>
			</label>

			{#if selectedWorkflow}
				<div class="fieldset-label flex flex-col gap-1">
					<span class="text-sm font-medium">Input</span>
					{#key selectedWorkflowId}
						<WorkflowInputForm
							fields={inputFields}
							bind:value={runInput}
							errors={runInputErrors}
							onjsonerror={(message) => (runInputJsonError = message)}
						/>
					{/key}
				</div>
			{/if}

			<p class="text-base-content/50 text-xs">
				Requires a `zigflow` worker already registered for the workflow's task queue — save the
				workflow with a valid DSL first (see the Workers page).
			</p>

			<div class="modal-action">
				<button type="button" class="btn" onclick={() => dialogEl?.close()}>Cancel</button>
				<button
					type="submit"
					class="btn btn-primary"
					disabled={running || !selectedWorkflowId || !!runInputJsonError}
				>
					{running ? 'Starting…' : 'Run'}
				</button>
			</div>
		</form>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
