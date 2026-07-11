<script lang="ts">
	import { enhance } from '$app/forms';
	import { FolderKanban, PenSquare, Plus, Search } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let search = $state('');
	let dialogEl: HTMLDialogElement | undefined;
	let creating = $state(false);

	function dialogRef(node: HTMLDialogElement) {
		dialogEl = node;
	}

	let filteredProjects = $derived(
		data.projects.filter((project) =>
			project.name.toLowerCase().includes(search.trim().toLowerCase())
		)
	);
</script>

<svelte:head>
	<title>Dashboard · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if data.apiError}
		<div class="alert alert-warning text-sm">
			<span>Couldn't reach the workflow API — showing no projects yet.</span>
		</div>
	{/if}

	<div class="flex flex-wrap items-center justify-between gap-3">
		<label class="input w-full max-w-xs">
			<Search size={16} class="text-base-content/50" />
			<input type="search" placeholder="Search projects…" bind:value={search} />
		</label>

		<button class="btn btn-primary" onclick={() => dialogEl?.showModal()}>
			<Plus size={16} />
			New Project
		</button>
	</div>

	{#if filteredProjects.length === 0}
		<div class="text-base-content/50 flex flex-col items-center gap-2 py-20">
			<FolderKanban size={40} />
			<p>
				{search ? 'No projects match your search.' : 'No projects yet — create your first one.'}
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each filteredProjects as project (project.id)}
				<div class="card bg-base-100 border-base-300 border shadow-sm transition hover:shadow-md">
					<div class="card-body gap-2">
						<h2 class="card-title text-base">{project.name}</h2>
						{#if project.description}
							<p class="text-base-content/60 line-clamp-2 text-sm">{project.description}</p>
						{/if}
						<div class="text-base-content/50 mt-2 flex items-center justify-between text-xs">
							<span>{project.workflowCount} workflow{project.workflowCount === 1 ? '' : 's'}</span>
							<span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
						</div>
						<div class="mt-1">
							<a
								href="/projects/{project.id}/workflows/demo/builder"
								class="btn btn-primary btn-sm w-full gap-1.5"
							>
								<PenSquare size={13} />
								Open Builder
							</a>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<dialog {@attach dialogRef} class="modal">
	<div class="modal-box">
		<h3 class="text-lg font-semibold">New project</h3>

		<form
			method="POST"
			action="?/create"
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
					{creating ? 'Creating…' : 'Create project'}
				</button>
			</div>
		</form>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
