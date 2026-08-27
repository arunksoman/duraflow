<script lang="ts">
	import { enhance } from '$app/forms';
	import { ListChecks, Play } from '@lucide/svelte';
	import type { PageProps } from './$types';
	import type { ExecutionStatus } from '$lib/types';

	let { data, form }: PageProps = $props();

	let dialogEl: HTMLDialogElement | undefined;
	let running = $state(false);

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
</script>

<svelte:head>
	<title>Executions · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-xl font-semibold">Executions</h1>
			<p class="text-base-content/60 mt-1 text-sm">Workflow runs across all projects, newest first.</p>
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

	{#if data.apiError}
		<div class="alert alert-warning text-sm"><span>Couldn't reach the executions API.</span></div>
	{/if}

	{#if data.executions.length === 0}
		<div class="text-base-content/50 flex flex-col items-center gap-2 py-20">
			<ListChecks size={40} />
			<p>No executions yet.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each data.executions as execution (execution.id)}
				<details class="border-base-300 bg-base-100 rounded-lg border">
					<summary class="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm">
						<span class="badge {statusClass[execution.status]} badge-sm">{execution.status}</span>
						<span class="font-medium">{execution.workflowName}</span>
						{#if execution.parentExecutionId}
							<span class="badge badge-ghost badge-xs">child of {execution.parentExecutionId.slice(0, 8)}</span>
						{/if}
						<span class="text-base-content/50 ml-auto text-xs">
							{new Date(execution.startedAt).toLocaleString()}
							{#if execution.completedAt}
								→ {new Date(execution.completedAt).toLocaleString()}
							{/if}
						</span>
					</summary>
					<div class="border-base-300 grid grid-cols-1 gap-3 border-t p-4 sm:grid-cols-2">
						<div>
							<p class="text-base-content/40 mb-1 text-[10px] font-semibold uppercase tracking-wider">
								Input
							</p>
							<pre class="bg-base-200 overflow-x-auto rounded p-2 text-xs">{execution.input
									? JSON.stringify(execution.input, null, 2)
									: '—'}</pre>
						</div>
						<div>
							<p class="text-base-content/40 mb-1 text-[10px] font-semibold uppercase tracking-wider">
								Output
							</p>
							<pre class="bg-base-200 overflow-x-auto rounded p-2 text-xs">{execution.output
									? JSON.stringify(execution.output, null, 2)
									: '—'}</pre>
						</div>
					</div>
				</details>
			{/each}
		</div>
	{/if}
</div>

<dialog {@attach dialogRef} class="modal">
	<div class="modal-box">
		<h3 class="text-lg font-semibold">Run a workflow</h3>

		<form
			method="POST"
			action="?/run"
			class="mt-4 flex flex-col gap-3"
			use:enhance={() => {
				running = true;
				return async ({ result, update }) => {
					running = false;
					if (result.type === 'success') dialogEl?.close();
					await update();
				};
			}}
		>
			{#if form?.error}
				<div class="alert alert-error py-2 text-sm"><span>{form.error}</span></div>
			{/if}

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Workflow</span>
				<select name="workflowId" class="select w-full" required>
					<option value="" disabled selected>Choose a workflow…</option>
					{#each data.workflows as workflow (workflow.id)}
						<option value={workflow.id}>{workflow.projectName} / {workflow.name}</option>
					{/each}
				</select>
			</label>

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Input (optional JSON)</span>
				<textarea
					name="input"
					class="textarea w-full font-mono"
					rows="4"
					placeholder={'{ "key": "value" }'}>{form?.inputRaw ?? ''}</textarea
				>
			</label>

			<p class="text-base-content/50 text-xs">
				Requires a `zigflow` worker already registered for the workflow's task queue — save the
				workflow with a valid DSL first (see the Workers page).
			</p>

			<div class="modal-action">
				<button type="button" class="btn" onclick={() => dialogEl?.close()}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={running}>
					{running ? 'Starting…' : 'Run'}
				</button>
			</div>
		</form>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
