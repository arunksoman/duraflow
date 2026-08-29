<script lang="ts">
	import { enhance } from '$app/forms';
	import { ArrowLeft, PenSquare, Plus, Trash2, Workflow as WorkflowIcon } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let dialogEl: HTMLDialogElement | undefined;
	let creating = $state(false);

	function dialogRef(node: HTMLDialogElement) {
		dialogEl = node;
	}
</script>

<svelte:head>
	<title>{data.project.name} · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if data.apiError}
		<div class="alert alert-warning text-sm">
			<span>Couldn't reach the workflow API — showing no workflows yet.</span>
		</div>
	{/if}

	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<a
				href="/dashboard"
				class="text-base-content/50 hover:text-base-content mb-1 flex items-center gap-1 text-xs transition"
			>
				<ArrowLeft size={12} />
				Dashboard
			</a>
			<h1 class="text-xl font-semibold">{data.project.name}</h1>
			{#if data.project.description}
				<p class="text-base-content/60 mt-1 text-sm">{data.project.description}</p>
			{/if}
		</div>

		<button class="btn btn-primary" onclick={() => dialogEl?.showModal()}>
			<Plus size={16} />
			New Workflow
		</button>
	</div>

	{#if data.workflows.length === 0}
		<div class="text-base-content/50 flex flex-col items-center gap-2 py-20">
			<WorkflowIcon size={40} />
			<p>No workflows yet — create your first one.</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.workflows as workflow (workflow.id)}
				<div class="card bg-base-100 border-base-300 border shadow-sm transition hover:shadow-md">
					<div class="card-body gap-2">
						<h2 class="card-title text-base">{workflow.name}</h2>
						{#if workflow.description}
							<p class="text-base-content/60 line-clamp-2 text-sm">{workflow.description}</p>
						{/if}
						<div class="text-base-content/50 mt-2 flex items-center justify-between text-xs">
							<span>v{workflow.version}</span>
							<span>Updated {new Date(workflow.updatedAt).toLocaleDateString()}</span>
						</div>
						<div class="mt-1 flex gap-2">
							<a
								href="/projects/{data.project.id}/workflows/{workflow.id}/builder"
								class="btn btn-primary btn-sm flex-1 gap-1.5"
							>
								<PenSquare size={13} />
								Open Builder
							</a>
							<form
								method="POST"
								action="?/deleteWorkflow"
								use:enhance
								onsubmit={(e) => {
									if (!confirm(`Delete "${workflow.name}"? This can't be undone.`)) {
										e.preventDefault();
									}
								}}
							>
								<input type="hidden" name="id" value={workflow.id} />
								<button type="submit" class="btn btn-ghost btn-sm text-error" title="Delete workflow">
									<Trash2 size={14} />
								</button>
							</form>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<dialog {@attach dialogRef} class="modal">
	<div class="modal-box">
		<h3 class="text-lg font-semibold">New workflow</h3>

		<form
			method="POST"
			action="?/createWorkflow"
			class="mt-4 flex flex-col gap-3"
			use:enhance={() => {
				creating = true;
				return async ({ result, update }) => {
					creating = false;
					if (result.type === 'success') dialogEl?.close();
					await update();
				};
			}}
		>
			{#if form?.error}
				<div class="alert alert-error py-2 text-sm">
					<span>{form.error}</span>
				</div>
			{/if}

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Name</span>
				<input
					name="name"
					class="input w-full"
					value={form?.name ?? ''}
					placeholder="Order Fulfillment"
					required
				/>
			</label>

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Description (optional)</span>
				<textarea name="description" class="textarea w-full" rows="2"
					>{form?.description ?? ''}</textarea
				>
			</label>

			<div class="modal-action">
				<button type="button" class="btn" onclick={() => dialogEl?.close()}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={creating}>
					{creating ? 'Creating…' : 'Create workflow'}
				</button>
			</div>
		</form>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
